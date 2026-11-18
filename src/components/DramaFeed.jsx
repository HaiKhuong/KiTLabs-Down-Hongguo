import { t, useLanguage, getLanguage } from '../i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Film, Flame, LayoutGrid, List, Play, RefreshCw } from './icons';
import RandomDrama, { DramaPoster } from './RandomDrama';
import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { feedCacheKey, readFeedCache, writeFeedCache } from './feedCache.mjs';
import { loadRandomPool, playRecommendedDrama, waitForRequest } from './randomDramaModel.mjs';
import './DramaFeed.css';

const CATALOG_CHANNEL_KEY = 'hongguo.feed.catalog.channel.v1';
const RANKINGS = [
  ['hot-drama', '热播总榜'], ['hot-real-drama', '真人短剧'],
  ['hot-comic-drama', '漫剧'], ['hot-ai-drama', 'AI 短剧'],
];

function clockOf(timestamp) {
  if (!timestamp) return '';
  const time = new Date(timestamp);
  return Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

function rankTierClass(rankNum) {
  if (rankNum === 1) return 'is-gold';
  if (rankNum === 2) return 'is-silver';
  if (rankNum === 3) return 'is-bronze';
  return '';
}

function DramaFeed({ active = true, onNavigate }) {
  useLanguage();
  const [source, setSource] = useState('hongguo');
  const [catalogChannel, setCatalogChannel] = useState(() => {
    try { return localStorage.getItem(CATALOG_CHANNEL_KEY) === 'web' ? 'web' : 'app'; }
    catch (_) { return 'app'; }
  });
  const { sources: mediaSources, revision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const [category, setCategory] = useState('hot-drama');
  const [items, setItems] = useState(() => readFeedCache(feedCacheKey(revision, source, category, catalogChannel))?.items || []);
  const [updatedAt, setUpdatedAt] = useState(() => readFeedCache(feedCacheKey(revision, source, category, catalogChannel))?.savedAt || 0);
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'grid'
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [playError, setPlayError] = useState('');
  const [randomRefresh, setRandomRefresh] = useState(0);
  const listController = useRef(null);
  const playController = useRef(null);
  const itemsRef = useRef([]);
  const revisionRef = useRef(revision);
  const random = category === 'random';
  const ranking = source === 'hongguo';
  const sourceLabel = mediaSourceLabel(source, mediaSources);
  itemsRef.current = items;

  const seedFeed = useCallback((nextSource, nextCategory, nextChannel = catalogChannel) => {
    const cached = nextCategory === 'random' ? null : readFeedCache(feedCacheKey(revision, nextSource, nextCategory, nextChannel));
    setItems(cached?.items || []);
    setUpdatedAt(cached?.savedAt || 0);
  }, [revision, catalogChannel]);

  const stopRequests = useCallback(() => {
    listController.current?.abort();
    playController.current?.abort();
    setResolvingId('');
    setPlayError('');
  }, []);

  const switchFeed = (nextSource, nextCategory) => {
    if (source === nextSource && category === nextCategory) return;
    stopRequests();
    setError(''); setNotice('');
    setLoading(nextCategory !== 'random');
    seedFeed(nextSource, nextCategory);
    setSource(nextSource); setCategory(nextCategory);
  };

  const switchCatalogChannel = next => {
    if (!['app', 'web'].includes(next) || next === catalogChannel) return;
    stopRequests();
    setError(''); setNotice(''); setLoading(true);
    seedFeed(source, category, next);
    setCatalogChannel(next);
    try { localStorage.setItem(CATALOG_CHANNEL_KEY, next); } catch (_) {}
  };

  const cancelLoad = () => {
    listController.current?.abort();
    setLoading(false);
    if (itemsRef.current.length) setNotice('已取消更新，仍显示上次片单。');
    else setError('已取消加载，可以重试或切换来源。');
  };

  const loadList = useCallback(async (forceRefresh = false) => {
    if (!active || random || sourcesLoading || !source) return;
    if (!mediaSources.some(item => item.id === source)) return;
    const key = feedCacheKey(revision, source, category, catalogChannel);
    const cached = readFeedCache(key);
    if (!itemsRef.current.length && cached?.items?.length) {
      setItems(cached.items); setUpdatedAt(cached.savedAt);
    }
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true); setError(''); setNotice('');
    try {
      let nextItems;
      if (ranking) {
        const result = await waitForRequest(window.electronAPI.browseList({
          source, category, page: 1, forceRefresh, catalogChannel,
        }), { signal: controller.signal, message: '热播榜加载超时，请重试' });
        if (controller.signal.aborted) return;
        if (!result?.success) throw new Error(result?.error || '热播榜暂时不可用');
        const seen = new Set();
        nextItems = (Array.isArray(result.results) ? result.results : []).filter(item => {
          const id = String(item?.series_id || '');
          if (!/^\d{6,30}$/.test(id) || typeof item.series_title !== 'string' || !item.series_title.trim() || seen.has(id)) return false;
          seen.add(id); return true;
        });
      } else {
        const result = await loadRandomPool(options => window.electronAPI.browseList(options), {
          source, sources: mediaSources, forceRefresh, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        nextItems = result.items;
      }
      if (!nextItems.length) {
        setError(itemsRef.current.length ? '来源这次没有返回片单，请稍后重试。' : '这个来源暂未返回可用片单，可重试或切换来源。');
        return;
      }
      const savedAt = Date.now();
      writeFeedCache(key, nextItems, savedAt);
      setItems(nextItems);
      setUpdatedAt(savedAt);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message || '片单加载失败，请重试或切换来源');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [active, random, sourcesLoading, source, category, catalogChannel, revision, ranking, mediaSources]);

  useEffect(() => {
    if (revisionRef.current === revision) return;
    revisionRef.current = revision;
    stopRequests();
    setItems([]); setUpdatedAt(0);
    setError(''); setNotice(''); setLoading(false);
  }, [revision, stopRequests]);

  useEffect(() => {
    if (sourcesLoading) return;
    if (!mediaSources.some(item => item.id === source)) {
      const next = mediaSources[0]?.id || '';
      if (next) {
        seedFeed(next, 'hot-drama');
        setLoading(true);
        setSource(next); setCategory('hot-drama');
      } else {
        setItems([]); setUpdatedAt(0); setLoading(false); setError(''); setNotice('');
      }
      return;
    }
    if (active && !random) loadList();
  }, [active, random, loadList, seedFeed, sourcesLoading, mediaSources, source]);

  useEffect(() => () => { listController.current?.abort(); playController.current?.abort(); }, []);

  const startItem = async (targetItem) => {
    if (!active || !targetItem || resolvingId || sourcesLoading) return;
    playController.current?.abort();
    const controller = new AbortController();
    playController.current = controller;
    const id = String(targetItem.series_id);
    setPlayError('');
    setResolvingId(id);
    try { await playRecommendedDrama(window.electronAPI, targetItem, { signal: controller.signal }); }
    catch (cause) { if (!controller.signal.aborted) setPlayError(cause.message || '加载失败，请重试本剧'); }
    finally { if (!controller.signal.aborted) setResolvingId(''); }
  };

  const cancelPlay = () => {
    playController.current?.abort();
    setResolvingId('');
    setPlayError('已取消加载，可重试本剧。');
  };

  const topItem = items[0] || null;
  const restItems = items.slice(1);
  const topIntro = topItem ? (topItem.intro || topItem.series_intro || topItem.description) : '';
  const topRank = topItem ? (ranking && topItem.rank > 0 ? topItem.rank : 1) : 1;

  return (
    <section className="drama-feed" aria-label={t("热播推荐")}>
      {/* 2. Page Header */}
      <header className="df-header">
        <div className="df-header-left">
          <div className="df-header-icon"><Flame size={20} /></div>
          <div>
            <h2>{t("热播推荐")}</h2>
            <p className="df-subtitle">{t("从热播榜和来源片单，遇见下一部故事。")}</p>
          </div>
        </div>
        <div className="df-header-right">
          {!random && (
            <label className="df-select-label">
              <span>{t("来源")}</span>
              <select className="df-select" aria-label={t("推荐来源")} value={source} onChange={event => switchFeed(event.target.value, 'hot-drama')}>
                {mediaSources.map(({ id, label }) => <option key={id} value={id}>{id.startsWith('custom:') ? label : t(label)}</option>)}
              </select>
            </label>
          )}
          {ranking && !random && (
            <label className="df-select-label">
              <span>{t("目录线路")}</span>
              <select className="df-select" aria-label={t("推荐目录线路")} value={catalogChannel} onChange={event => switchCatalogChannel(event.target.value)}>
                <option value="app">{t("App（快速 · 部分片单）")}</option>
                <option value="web">{t("官网（完整目录）")}</option>
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={!random && (sourcesLoading || !source || (loading && !items.length))}
            onClick={() => random ? setRandomRefresh(value => value + 1) : loadList(true)}
          >
            <RefreshCw size={14} className={loading && !random ? 'spin' : ''} />
            <span>{t("刷新片单")}</span>
          </button>
        </div>
      </header>

      {/* 3. Trending Categories */}
      <div className="df-categories" role="group" aria-label={t("选择推荐方式")}>
        {ranking ? RANKINGS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`df-cat-tab ${category === value ? 'is-active' : ''}`}
            aria-pressed={category === value}
            onClick={() => switchFeed(source, value)}
          >
            {t(label)}
          </button>
        )) : (
          <button
            type="button"
            className={`df-cat-tab ${!random ? 'is-active' : ''}`}
            aria-pressed={!random}
            onClick={() => switchFeed(source, 'hot-drama')}
          >
            {t("来源片单")}
          </button>
        )}
        <button
          type="button"
          className={`df-cat-tab ${random ? 'is-active' : ''}`}
          aria-pressed={random}
          onClick={() => switchFeed(source, 'random')}
        >
          {t("摇一摇")}
        </button>
      </div>

      {random ? (
        <RandomDrama active={active} refreshKey={randomRefresh} onNavigate={onNavigate} />
      ) : (
        <>
          {sourcesError && <p className="df-notice-banner" role="status">{t("来源列表更新失败，暂用上次列表；可在设置重新保存来源后重试。")}</p>}
          {ranking && catalogChannel === 'app' && (
            <p className="df-notice-banner" role="status">{t("快速线路只显示部分片单；需要更完整的榜单时，可在“目录线路”切换到官网。")}</p>
          )}

          {(loading || sourcesLoading) && items.length === 0 && (
            <div className="df-state-card" role="status">
              <RefreshCw size={26} className="spin" />
              <p>{t(sourcesLoading ? '正在加载来源列表…' : '正在加载真实片单…')}</p>
              {loading && !sourcesLoading && <button type="button" className="btn btn-outline btn-sm" onClick={cancelLoad}>{t("取消加载")}</button>}
            </div>
          )}

          {loading && items.length > 0 && (
            <div className="df-updating-bar" role="status">
              <span><RefreshCw size={14} className="spin" /> {t("正在更新片单，仍可浏览上次结果…")}</span>
              <button type="button" className="btn btn-outline btn-sm" onClick={cancelLoad}>{t("取消加载")}</button>
            </div>
          )}

          {notice && items.length > 0 && <p className="df-notice-banner" role="status">{t(notice)}</p>}

          {error && items.length > 0 && (
            <div className="alert alert-error df-error-bar" role="alert">
              <span>{t("片单未更新：")}{t(error)}{updatedAt ? t(`（仍显示 ${clockOf(updatedAt)} 的片单）`) : ''}</span>
              <button type="button" className="btn btn-outline btn-sm" disabled={loading} onClick={() => loadList(true)}>{t("重试")}</button>
            </div>
          )}

          {playError && (
            <div className="alert alert-error df-error-bar" role="alert">
              <span>{t(playError)}</span>
            </div>
          )}

          {!loading && !sourcesLoading && !topItem && (
            <div className="df-state-card" role={error ? 'alert' : 'status'}>
              <Film size={32} />
              <h3>{t(error ? '暂时没能加载片单' : !source ? '暂无启用的来源，请在设置中添加' : '这个来源暂未返回剧集')}</h3>
              {error && <p>{t(error)}</p>}
              <p>{t(ranking ? '可在上方切换目录线路或来源，继续发现短剧。' : '可在上方切换来源，继续发现短剧。')}</p>
              <div className="df-state-actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={!source} onClick={() => loadList(true)}>{t("重新加载")}</button>
                {onNavigate && <button type="button" className="btn btn-outline btn-sm" onClick={() => onNavigate('download')}>{t("按剧名搜索")}</button>}
              </div>
            </div>
          )}

          {/* 4. Featured TOP 1 */}
          {topItem && (
            <article className="df-hero">
              {topItem.cover && <div className="df-hero-backdrop" style={{ backgroundImage: `url(${topItem.cover})` }} aria-hidden="true" />}
              <div className="df-hero-overlay" aria-hidden="true" />
              <div className="df-hero-inner">
                <div className="df-hero-poster">
                  <DramaPoster item={topItem} />
                </div>
                <div className="df-hero-body">
                  <div className="df-hero-badges">
                    <span className="df-rank-pill is-gold">TOP {topRank}</span>
                    {ranking && topItem.heat && <span className="df-heat-pill">{topItem.heat}</span>}
                  </div>
                  <h3 className="df-hero-title">{topItem.series_title}</h3>
                  <p className="df-hero-meta">
                    {[topItem.episode_count > 0 && t('{0} 集', [topItem.episode_count]), ...(topItem.tags || [])].filter(Boolean).join(' · ') || t('来自{0}片单', [sourceLabel])}
                  </p>
                  {typeof topIntro === 'string' && topIntro.trim() && (
                    <p className="df-hero-intro">{topIntro}</p>
                  )}
                  <div className="df-hero-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={!!resolvingId}
                      onClick={() => startItem(topItem)}
                    >
                      <Play size={14} />
                      <span>{t(resolvingId === String(topItem.series_id) ? '正在打开剧库…' : '在剧库播放')}</span>
                    </button>
                    {resolvingId === String(topItem.series_id) && (
                      <button type="button" className="btn btn-outline btn-sm" onClick={cancelPlay}>{t("取消加载")}</button>
                    )}
                  </div>
                </div>
              </div>
            </article>
          )}

          {/* 5, 6, 7. Trending Ranking List / Grid (Rank 2+) */}
          {restItems.length > 0 && (
            <section className="df-ranking-section">
              <div className="df-list-header">
                <div className="df-list-meta">
                  <h3>{t(ranking ? (catalogChannel === 'app' ? '红果 App 热播榜' : '红果官网热播榜') : `${sourceLabel} · 来源片单`)}</h3>
                  <span className="df-count-pill">{items.length}</span>
                  <span className="df-order-note">{t(ranking ? '按来源榜单顺序' : '按来源目录顺序，不代表热播排名')}</span>
                </div>
                <div className="browse-view-toggle" role="group" aria-label="View mode">
                  <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')} title="List view" aria-label="List view">
                    <List size={14} />
                  </button>
                  <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')} title="Grid view" aria-label="Grid view">
                    <LayoutGrid size={14} />
                  </button>
                </div>
              </div>

              {viewMode === 'list' ? (
                <ul className="df-ranking-list">
                  {restItems.map((item, offset) => {
                    const rankNum = ranking && item.rank > 0 ? item.rank : offset + 2;
                    const intro = item.intro || item.series_intro || item.description;
                    const isResolving = resolvingId === String(item.series_id);
                    return (
                      <li key={item.series_id} className="df-rank-row">
                        <span className={`df-rank-num ${rankTierClass(rankNum)}`}>{rankNum}</span>
                        <div className="df-row-poster"><DramaPoster item={item} /></div>
                        <div className="df-row-info">
                          <div className="df-row-title-line">
                            <h4 className="df-row-title">{item.series_title}</h4>
                            {ranking && item.heat && <span className="df-heat-text">{item.heat}</span>}
                          </div>
                          <p className="df-row-meta">
                            {[item.episode_count > 0 && t('{0} 集', [item.episode_count]), ...(item.tags || [])].filter(Boolean).join(' · ') || t('来自{0}片单', [sourceLabel])}
                          </p>
                          {typeof intro === 'string' && intro.trim() && <p className="df-row-intro">{intro}</p>}
                        </div>
                        <div className="df-row-actions">
                          <button
                            type="button"
                            className="btn btn-outline btn-sm"
                            disabled={!!resolvingId}
                            onClick={() => startItem(item)}
                          >
                            <Play size={13} />
                            <span>{t(isResolving ? '正在打开剧库…' : '在剧库播放')}</span>
                          </button>
                          {isResolving && (
                            <button type="button" className="btn btn-outline btn-sm" onClick={cancelPlay}>{t("取消加载")}</button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <ul className="df-ranking-grid">
                  {restItems.map((item, offset) => {
                    const rankNum = ranking && item.rank > 0 ? item.rank : offset + 2;
                    const isResolving = resolvingId === String(item.series_id);
                    return (
                      <li key={item.series_id} className="df-grid-card" onClick={() => startItem(item)}>
                        <div className="df-grid-poster-wrap">
                          <DramaPoster item={item} />
                          <span className={`df-grid-rank ${rankTierClass(rankNum)}`}>#{rankNum}</span>
                          <div className="df-grid-play-overlay">
                            <span className="btn btn-primary btn-sm">
                              <Play size={13} /><span>{t(isResolving ? '正在打开剧库…' : '在剧库播放')}</span>
                            </span>
                          </div>
                        </div>
                        <div className="df-grid-info">
                          <h4 className="df-grid-title" title={item.series_title}>{item.series_title}</h4>
                          <p className="df-grid-meta">
                            {[item.episode_count > 0 && t('{0} 集', [item.episode_count]), ...(item.tags || []).slice(0, 2)].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <p className="df-source-foot">
                {t(ranking ? `榜单来自${catalogChannel === 'app' ? '红果 App 目录' : '红果官网公开页面'}，不是账号个性化推荐。` : `片单来自${sourceLabel}当前目录，不代表热播排名；播放以来源实际可用分集为准。`)}
              </p>
            </section>
          )}
        </>
      )}
    </section>
  );
}

export default DramaFeed;
