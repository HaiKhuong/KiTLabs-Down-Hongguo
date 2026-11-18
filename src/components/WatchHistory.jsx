import { t, useLanguage, getLanguage } from '../i18n';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Clock, Info, LayoutGrid, List, CheckCircle, Trash2, MoreHorizontal } from './icons';
import './WatchHistory.css';
import { groupHistory, historyGroupSuggestions } from './historyGroups.mjs';

const PREFERENCES_KEY = 'hongguo:watch-history-preferences';
const MAX_VISIBLE_CHIPS = 3;

export default function WatchHistory({ active = true, onNavigate }) {
  useLanguage();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkingRow, setCheckingRow] = useState('');
  const [opening, setOpening] = useState('');
  const [removing, setRemoving] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState({});
  const [expandedChips, setExpandedChips] = useState({});
  const [showInfo, setShowInfo] = useState(false);
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'grid'
  const [decisions, setDecisions] = useState(() => {
    try { const value = JSON.parse(localStorage.getItem('hongguo:history-groups')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
  });
  const decide = (id, target) => {
    const next = { ...decisions };
    if (target === null) {
      const remaining = groupHistory(rows, decisions).find(items => items.some(row => row.series_id === id))?.filter(row => row.series_id !== id) || [];
      // Keep the new anchor manual so its automatic family cannot absorb other rows.
      for (const row of remaining) if (next[row.series_id] === id) next[row.series_id] = remaining[0].series_id;
    }
    if (target === undefined) delete next[id]; else next[id] = target;
    try { localStorage.setItem('hongguo:history-groups', JSON.stringify(next)); setDecisions(next); }
    catch { setError('分组未能保存，请检查本地存储后重试'); }
  };
  const [filter, setFilter] = useState('all');
  const [preferences, setPreferences] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY));
      return {
        scope: ['all', 'latest', 'unfinished', 'skip-completed-low'].includes(saved?.scope) ? saved.scope : 'all',
        hideLowSeasons: saved?.hideLowSeasons === true,
      };
    } catch { return { scope: 'all', hideLowSeasons: false }; }
  });
  const { scope, hideLowSeasons } = preferences;
  const [progress, setProgress] = useState(null);
  const request = useRef(0);
  const openingRef = useRef(false);
  const openingRequest = useRef(0);
  const groups = groupHistory(rows, decisions);
  const groupById = new Map(groups.flatMap(items => items.map(row => [row.series_id, items])));
  const suggestionsByGroup = new Map(groups.map(items => [items, historyGroupSuggestions(items)]));
  const listedGroups = groups.map(items => hideLowSeasons && !expanded[items[0].series_id] ? items.slice(0, 1) : items);
  const listedRows = listedGroups.flat();
  const completedCount = listedRows.filter(row => row.completed === true).length;
  const unfinishedCount = listedRows.length - completedCount;
  const visibleRows = listedGroups.map(items => items
    .filter(row => filter === 'all' || (row.completed === true) === (filter === 'completed'))
    .sort((a, b) => b.updatedAt - a.updatedAt))
    .filter(items => items.length).sort((a, b) => b[0].updatedAt - a[0].updatedAt).flat();

  const savePreferences = next => {
    setPreferences(next);
    try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); }
    catch { setStatus('本次选择已生效，但未能保存；重启后可能恢复默认。'); }
  };

  const load = async () => {
    const version = ++request.current;
    try {
      const result = await window.electronAPI.getWatchHistory();
      if (version !== request.current) return;
      if (!result?.success) throw new Error(result?.error || '观看记录加载失败');
      setRows(result.results || []);
      setError('');
    } catch (failure) {
      if (version === request.current) setError(failure.message || '观看记录加载失败，请重试');
    } finally { if (version === request.current) setLoading(false); }
  };

  useLayoutEffect(() => {
    setOpening(''); openingRef.current = false;
    return () => { openingRequest.current++; openingRef.current = false; };
  }, [active]);
  useEffect(() => {
    if (active) load();
    return () => { request.current++; };
  }, [active]);
  useEffect(() => window.electronAPI.onWatchHistoryUpdated?.(() => { if (active) load(); }), [active]);
  useEffect(() => window.electronAPI.onWatchHistoryProgress?.(data => { if (active) setProgress(data); }), [active]);

  const checkUpdates = async () => {
    setChecking(true); setStatus(''); setError(''); setProgress(null);
    try {
      const result = await window.electronAPI.refreshWatchHistory({ scope });
      if (!result?.success) throw new Error(result?.error || '检查失败，请重试');
      await load();
      setStatus(`已检查 ${result.checked} 部${result.failed ? `，${result.failed} 部未完成，可稍后重试` : ''}${result.remaining ? `；本次预算内还有 ${result.remaining} 部，点击继续检查` : ''}`);
    } catch (failure) { setError(failure.message || '检查失败，请重试'); }
    finally { setChecking(false); setProgress(null); }
  };

  const checkRow = async (row) => {
    if (checking || checkingRow) return;
    setCheckingRow(row.series_id); setStatus(''); setError('');
    try {
      const result = await window.electronAPI.checkWatchHistoryItem(row.series_id);
      if (!result?.success) throw new Error(result?.error || '检查失败，请重试');
      await load();
      setStatus(result.error
        ? `《${row.series_title}》分集已检查；续作检查未完成：${result.error}`
        : `《${row.series_title}》${result.checked ? '已检测完成' : '没有可更新的记录'}。`);
    } catch (failure) {
      await load();
      setError(failure.message || '检查失败，请重试');
    }
    finally { setCheckingRow(''); }
  };

  const remove = async (row) => {
    setRemoving(row.series_id); setError(''); setStatus('');
    try {
      const result = await window.electronAPI.removeWatchHistory(row.series_id);
      if (!result?.success) throw new Error(result?.error || '移除失败，请重试');
      setRows(current => current.filter(item => item.series_id !== row.series_id));
      setStatus(`已移除《${row.series_title}》的观看记录，视频文件不受影响。`);
      void load();
    } catch (failure) { setError(failure.message || '移除失败，请重试'); }
    finally { setRemoving(''); }
  };

  const resume = async (row, sequel = null) => {
    if (!active || openingRef.current) return;
    const version = ++openingRequest.current;
    openingRef.current = true;
    setOpening(row.series_id); setError('');
    try {
      if (sequel) {
        let result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: 1 });
        if (!result?.success && version !== openingRequest.current) return;
        if (!result?.success && result?.code === 'SERIES_NOT_FOUND') {
          const detail = await window.electronAPI.searchResolve(sequel.series_id);
          if (version !== openingRequest.current) return;
          if (!detail?.success) throw new Error(detail?.error || '续作详情暂不可用');
          const episode = detail.data?.episodes?.find(item => !item.locked);
          if (!episode) throw new Error('续作暂时没有可播放的分集');
          result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: episode.vid_index });
        }
        if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      } else {
        const result = await window.electronAPI.playSeries({ seriesId: row.series_id, vidIndex: row.vid_index, resume: true });
        if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      }
      // An unconfirmed title match must not clear the original show's update markers.
      if (sequel && row.similarSeries?.some(item => item.series_id === sequel.series_id)) return;
      const group = groupById.get(row.series_id) || [row];
      const acknowledgedRows = sequel || visibleRows.find(item => groupById.get(item.series_id) === group) === row
        ? group.filter(item => item === row || item.sequels?.some(candidate => !sequel || candidate.series_id === sequel.series_id))
        : [row];
      for (const target of acknowledgedRows) {
        const resumedOriginal = !sequel && target === row;
        const snapshot = { total: resumedOriginal ? row.total : 0, sequelIds: sequel ? [sequel.series_id] : (target.sequels || []).map(item => item.series_id) };
        const acknowledged = await window.electronAPI.acknowledgeWatchUpdates(target.series_id, snapshot);
        if (!acknowledged?.success) throw new Error(acknowledged?.error || '更新标记保存失败');
        if (version === openingRequest.current) setRows(current => current.map(item => {
          if (item.series_id !== target.series_id) return item;
          const unreadEpisodes = resumedOriginal ? 0 : item.unreadEpisodes || 0;
          const unreadSequelIds = (item.unreadSequelIds || []).filter(id => !snapshot.sequelIds.includes(id));
          return { ...item, hasUpdates: unreadEpisodes > 0 || unreadSequelIds.length > 0, unreadEpisodes, unreadSequelIds };
        }));
      }
    } catch (failure) { if (version === openingRequest.current) setError(failure.message || '打开失败，请重试'); }
    finally { if (version === openingRequest.current) { setOpening(''); openingRef.current = false; } }
  };

  const emptyTitle = hideLowSeasons
    ? filter === 'completed' ? '最高季里没有已看完的短剧' : '最高季里没有未看完的短剧'
    : filter === 'completed' ? '还没有已看完的短剧' : '没有未看完的短剧';

  return (
    <section className="history-container" aria-labelledby="history-title">
      {/* 2. Page Header */}
      <header className="wh-header">
        <div className="wh-header-left">
          <div className="wh-header-icon"><Clock size={20} /></div>
          <div>
            <h1 id="history-title">{t("观看记录")}</h1>
            <p className="wh-subtitle">{t("继续上次的故事。记录仅保存在这台电脑。")}</p>
          </div>
        </div>
        <div className="wh-header-right">
          <div className="wh-summary-pills">
            <span className="wh-summary-pill">{t("全部")} {listedRows.length}</span>
            <span className="wh-summary-pill is-active">{t("未看完")} {unfinishedCount}</span>
            <span className="wh-summary-pill is-done">{t("已看完")} {completedCount}</span>
          </div>
          <button
            type="button"
            className={`icon-btn wh-info-btn ${showInfo ? 'is-active' : ''}`}
            title={t("运行期间自动检查新集；同一部剧的多个季会共用一次续作搜索，已看完的低季每 24 小时检测一次。不同剧号的新一季标为“疑似续作”。批量检测范围只决定本次检查哪些记录，不会隐藏记录或清除已有红点。同组续作和疑似同剧汇总到组头，子级红点仅表示新增分集。可在设置中关闭检测或开启系统通知。")}
            aria-label={t("批量检测范围")}
            aria-expanded={showInfo}
            onClick={() => setShowInfo(v => !v)}
          >
            <Info size={16} />
          </button>
        </div>
      </header>

      {showInfo && (
        <div className="wh-info-banner">
          <p>{t("运行期间自动检查新集；同一部剧的多个季会共用一次续作搜索，已看完的低季每 24 小时检测一次。不同剧号的新一季标为“疑似续作”。批量检测范围只决定本次检查哪些记录，不会隐藏记录或清除已有红点。同组续作和疑似同剧汇总到组头，子级红点仅表示新增分集。可在设置中关闭检测或开启系统通知。")}</p>
          <p>{t("按最近观看时间排序，检查更新不改变观看顺序。同组提醒汇总到首个可见记录。")}{t("按当前最后一集的片尾进度判断；隐藏低季后，计数仅代表列表中的季，旧记录可能显示未看完。")}</p>
        </div>
      )}

      {/* 3. Filter Toolbar */}
      <div className="wh-toolbar">
        <div className="wh-filter-tabs" role="group" aria-label={t("观看进度筛选")}>
          {[
            ['all', '全部', listedRows.length],
            ['unfinished', '未看完', unfinishedCount],
            ['completed', '已看完', completedCount],
          ].map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'is-active' : ''}
              aria-pressed={filter === value}
              disabled={loading}
              onClick={() => setFilter(value)}
            >
              <span>{t(label)}</span>
              <em className="wh-tab-count">{count}</em>
            </button>
          ))}
        </div>

        <div className="wh-tools-right">
          <select
            className="wh-scope-select"
            value={scope}
            onChange={event => savePreferences({ ...preferences, scope: event.target.value })}
            disabled={checking || !!checkingRow || loading}
            aria-label={t("批量检测范围")}
          >
            <option value="all">{t("全部记录")}</option>
            <option value="latest">{t("仅最高季")}</option>
            <option value="unfinished">{t("仅未看完")}</option>
            <option value="skip-completed-low">{t("排除已看完低季")}</option>
          </select>

          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={checkUpdates}
            disabled={checking || !!checkingRow || loading || !rows.length}
          >
            <RefreshCw size={14} className={checking ? 'spin' : ''} />
            <span>{t(checking ? '正在检查更新…' : '检查更新')}</span>
          </button>

          <label className="wh-collapse-check" title={t("只调整当前列表；批量检测范围不变，也不会删除记录")}>
            <input
              type="checkbox"
              checked={hideLowSeasons}
              disabled={loading}
              onChange={event => savePreferences({ ...preferences, hideLowSeasons: event.target.checked })}
            />
            <span>{t("折叠同剧低季")}</span>
          </label>

          <div className="browse-view-toggle" role="group" aria-label="View mode">
            <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')} title="List view" aria-label="List view">
              <List size={14} />
            </button>
            <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')} title="Grid view" aria-label="Grid view">
              <LayoutGrid size={14} />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="alert alert-error wh-alert" role="alert">
          <span>{t(error)}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={load}>{t("重新加载")}</button>
        </div>
      )}
      {status && <p className="wh-status-msg" role="status">{t(status)}</p>}
      {checking && progress?.total > 0 && (
        <p className="wh-status-msg" role="status">
          {t("正在检查 ")}{(progress.checked || 0) + (progress.failed || 0) + (progress.skipped || 0)} / {progress.total}{progress.current ? `：${progress.current}` : ''}
        </p>
      )}

      {/* 8. Empty States & Cards */}
      {loading ? (
        <div className="wh-empty" role="status"><p>{t("正在读取观看记录…")}</p></div>
      ) : !rows.length ? (
        <div className="wh-empty">
          <Clock size={34} />
          <h2>{t("还没有观看记录")}</h2>
          <p>{t("真正开始播放后，短剧和进度会出现在这里。")}</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate?.('browse')}>{t("去发现短剧")}</button>
        </div>
      ) : !visibleRows.length ? (
        <div className="wh-empty" role="status">
          <Clock size={34} />
          <h2>{t(emptyTitle)}</h2>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setFilter('all')}>{t("查看全部")}</button>
        </div>
      ) : (
        <ul className={viewMode === 'grid' ? 'wh-cards-grid' : 'wh-cards-list'}>
          {visibleRows.map(row => {
            const group = groupById.get(row.series_id);
            const groupHeadId = group[0].series_id;
            const isHead = visibleRows.find(item => groupById.get(item.series_id) === group) === row;
            const { sequels, similarSeries: similar, hasUnreadSequels } = suggestionsByGroup.get(group);
            const hasUpdates = row.unreadEpisodes > 0 || (isHead && hasUnreadSequels);
            const epTotal = Number(row.total) || 0;
            const epIdx = Number(row.vid_index) || 0;
            const pct = row.completed ? 100 : (epTotal > 0 ? Math.min(100, Math.max(0, Math.round((epIdx / epTotal) * 1000) / 10)) : 0);
            const timeLabel = `${Math.floor((row.currentTime || 0) / 60)}:${String(Math.floor((row.currentTime || 0) % 60)).padStart(2, '0')}`;
            const chipsExpanded = !!expandedChips[row.series_id];

            return (
              <li className={`wh-card ${!isHead ? 'is-child' : ''}`} key={row.series_id}>
                <div className="wh-card-main">
                  {/* Poster */}
                  <button
                    type="button"
                    className="wh-poster-btn"
                    onClick={() => resume(row)}
                    disabled={!active || !!opening || !!removing}
                    aria-label={t(`继续观看 ${row.series_title} 第${row.vid_index}集`)}
                  >
                    {row.cover
                      ? <img className="wh-poster" src={row.cover} alt="" loading="lazy" />
                      : <span className="wh-poster wh-poster-empty"><Play size={20} /></span>}
                  </button>

                  {/* Drama Information */}
                  <div className="wh-info">
                    <div className="wh-title-row">
                      {hasUpdates && <span className="wh-update-dot" role="img" aria-label={t("有更新")} />}
                      <h3 className="wh-title" title={row.series_title}>{row.series_title}</h3>
                      {row.unreadEpisodes > 0 && <span className="wh-badge is-new">{t("新增 ")}{row.unreadEpisodes}{t(" 集")}</span>}
                      {row.completed && (
                        <span className="wh-badge is-done">
                          <CheckCircle size={11} />
                          <span>{t("已看完")}</span>
                        </span>
                      )}
                      {decisions[row.series_id] === null
                        ? <span className="wh-badge is-group">{t("独立显示 · 手动")}</span>
                        : group.length > 1 && group.some(item => Object.hasOwn(decisions, item.series_id)) && (
                          <span className="wh-badge is-group">{t("手动分组")}</span>
                        )}
                    </div>

                    <p className="wh-meta-ep">
                      {t("看到第 ")}{row.vid_index}{t(" 集 / 共 ")}{row.total}{t(" 集 · ")}{timeLabel}
                    </p>
                    <p className="wh-meta-time">
                      {t("最近观看 ")}{new Date(row.updatedAt).toLocaleString(getLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>

                    <div className="wh-progress-row">
                      <div className="wh-progress-track">
                        <div className={`wh-progress-fill ${row.completed ? 'is-done' : ''}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="wh-progress-pct">{pct}%</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="wh-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm wh-btn-continue"
                      onClick={() => resume(row)}
                      disabled={!active || !!opening || !!removing}
                    >
                      <Play size={13} />
                      <span>{t(opening === row.series_id ? '打开中…' : '继续观看')}</span>
                    </button>

                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      disabled={checking || !!checkingRow || !!removing || !!opening}
                      aria-label={t(`检测《${row.series_title}》的更新`)}
                      title={t("只检测这一条观看记录")}
                      onClick={() => checkRow(row)}
                    >
                      <RefreshCw size={13} className={checkingRow === row.series_id ? 'spin' : ''} />
                      <span>{t(checkingRow === row.series_id ? '检测中…' : '检测')}</span>
                    </button>

                    <details className="wh-more-menu">
                      <summary className="icon-btn" aria-label={t("更多操作")} title={t("更多操作")}>
                        <MoreHorizontal size={15} />
                      </summary>
                      <div className="wh-more-dropdown" onClick={(e) => { const d = e.currentTarget.closest('details'); if (d && e.target.closest('button')) d.open = false; }}>
                        {group.length > 1 && isHead && (
                          <button type="button" onClick={() => {
                            if (!hideLowSeasons) savePreferences({ ...preferences, hideLowSeasons: true });
                            setExpanded(value => ({ ...value, [groupHeadId]: hideLowSeasons ? !value[groupHeadId] : false }));
                          }}>
                            {t(!hideLowSeasons || expanded[groupHeadId] ? '折叠组' : '展开组')}
                          </button>
                        )}
                        {group.length > 1 && (
                          <button type="button" onClick={() => decide(row.series_id, null)}>{t("独立显示")}</button>
                        )}
                        {Object.hasOwn(decisions, row.series_id) && (
                          <button type="button" onClick={() => decide(row.series_id, undefined)}>{t("恢复自动分组")}</button>
                        )}
                        <button
                          type="button"
                          className="is-danger"
                          disabled={!!removing || !!opening || !!checkingRow}
                          title={t("仅移除观看记录，不删除视频文件")}
                          onClick={() => remove(row)}
                        >
                          <Trash2 size={13} />
                          <span>{t(removing === row.series_id ? '移除中…' : '移除')}</span>
                        </button>
                      </div>
                    </details>
                  </div>
                </div>

                {/* 5. Related Seasons / Sequels */}
                {isHead && !!sequels.length && (
                  <div className="wh-related-row">
                    <span className="wh-related-label">{t("疑似续作")}</span>
                    <div className="wh-related-chips">
                      {(chipsExpanded ? sequels : sequels.slice(0, MAX_VISIBLE_CHIPS)).map(sequel => (
                        <button
                          key={sequel.series_id}
                          type="button"
                          className="wh-chip"
                          title={sequel.series_title}
                          disabled={!active || !!opening || !!removing}
                          onClick={() => resume(sequel.origin, sequel)}
                        >
                          {sequel.series_title}
                        </button>
                      ))}
                      {!chipsExpanded && sequels.length > MAX_VISIBLE_CHIPS && (
                        <button type="button" className="wh-chip is-more" onClick={() => setExpandedChips(p => ({ ...p, [row.series_id]: true }))}>
                          +{sequels.length - MAX_VISIBLE_CHIPS}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {isHead && !!similar.length && (
                  <div className="wh-related-row" title={t("名称相近，仅供核对；不会用于隐藏低季或批量归组")}>
                    <span className="wh-related-label">{t("疑似同剧（仅提示）")}</span>
                    <div className="wh-related-chips">
                      {(chipsExpanded ? similar : similar.slice(0, MAX_VISIBLE_CHIPS)).map(candidate => (
                        <button
                          key={candidate.series_id}
                          type="button"
                          className="wh-chip"
                          title={candidate.series_title}
                          disabled={!active || !!opening || !!removing}
                          onClick={() => resume(candidate.origin, candidate)}
                        >
                          {candidate.series_title}
                        </button>
                      ))}
                      {!chipsExpanded && similar.length > MAX_VISIBLE_CHIPS && (
                        <button type="button" className="wh-chip is-more" onClick={() => setExpandedChips(p => ({ ...p, [row.series_id]: true }))}>
                          +{similar.length - MAX_VISIBLE_CHIPS}
                        </button>
                      )}
                      {similar.filter(candidate => rows.some(item => item.series_id === candidate.series_id)).map(candidate => (
                        <button key={`group:${candidate.series_id}`} type="button" className="wh-chip is-confirm" onClick={() => decide(candidate.series_id, row.series_id)}>
                          {t("确认《")}{candidate.series_title}{t("》为同剧")}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {row.lastEpisodeCheckError && <p className="wh-check-error">{t("分集更新检查未完成：")}{t(row.lastEpisodeCheckError)}</p>}
                {row.lastSequelCheckError && <p className="wh-check-error">{t("续作检查未完成：")}{t(row.lastSequelCheckError)}</p>}
                {!row.lastEpisodeCheckError && !row.lastSequelCheckError && row.lastCheckError && (
                  <p className="wh-check-error">{t("更新检查未完成：")}{t(row.lastCheckError)}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
