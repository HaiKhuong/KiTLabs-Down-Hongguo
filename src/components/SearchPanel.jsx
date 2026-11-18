import { t, useLanguage } from '../i18n';
import React, { useState, useRef, useEffect } from 'react';
import './HongguoDownload.css';
import { Search, Film, RefreshCw, ExternalLink, X, Eye, ChevronDown } from './icons';
import { isSubmitKey } from './episodeRange';
import { readSearchHistory, saveSearchTerm, removeSearchTerm, clearSearchHistory, rememberCatalogTitles, getSearchSuggestions } from '../searchHistory';

import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { rankSearchResults } from './searchRanking.mjs';

const SEARCH_SAFETY_TIMEOUT_MS = 25000;

/**
 * SearchPanel —— 按所选来源搜索短剧
 * 拿到 series_id 后交给父组件走既有的「拉全集 + 选集下载」流程。
 */
function SearchPanel({ onSelectSeries, onViewSeries, onSwitchToInput, onResolveInput, externalQuery = '', compactWelcome = false, active = true }) {
  useLanguage();
  const [source, setSource] = useState('all');
  const { sources: mediaSources, revision: sourceRevision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const requestVersion = useRef(0);
  const pendingSearch = useRef(null);
  useEffect(() => () => { requestVersion.current++; cancelMore(); }, []);
  const [keyword, setKeyword] = useState('');
  const lastExternalQuery = useRef('');
  const [history, setHistory] = useState(readSearchHistory);
  const [historyError, setHistoryError] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    // Chromium's native datalist can stay at its old screen position after a container scroll.
    const dismissSuggestions = () => inputRef.current?.blur();
    window.addEventListener('scroll', dismissSuggestions, true);
    window.addEventListener('resize', dismissSuggestions);
    return () => {
      window.removeEventListener('scroll', dismissSuggestions, true);
      window.removeEventListener('resize', dismissSuggestions);
    };
  }, []);
  const suggestions = getSearchSuggestions(keyword, history);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null); // null=未搜索, []=无结果
  const [error, setError] = useState('');
  const [searchWarning, setSearchWarning] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [searchedKeyword, setSearchedKeyword] = useState('');
  const [more, setMore] = useState({});
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState('');
  const moreRequest = useRef(null);
  const [pickingId, setPickingId] = useState('');
  const cancelMore = () => {
    clearTimeout(moreRequest.current?.timer);
    moreRequest.current = null;
  };

  useEffect(() => {
    if (!active) {
      requestVersion.current++;
      pendingSearch.current = null;
      setPickingId('');
      setLoading(false);
      cancelMore(); setMoreLoading(false); setMoreError('');
    }
  }, [active]);

  useEffect(() => {
    requestVersion.current++; pendingSearch.current = null;
    setLoading(false); setPickingId(''); setResults(null); setError(''); setSearchWarning(''); setPageTitle(''); setMore({}); setMoreError(''); setMoreLoading(false); cancelMore();
    if (source !== 'all' && !mediaSources.some(item => item.id === source)) setSource('all');
  }, [sourceRevision, mediaSources]);

  const switchSource = (next) => {
    if (next === source) return;
    requestVersion.current++;
    pendingSearch.current = null;
    setSource(next);
    setLoading(false);
    setPickingId('');
    setResults(null);
    setError('');
    setSearchWarning('');
    setPageTitle('');
    setMore({}); setMoreError(''); setMoreLoading(false); cancelMore();
  };

  const changeKeyword = (value) => {
    requestVersion.current++;
    pendingSearch.current = null;
    setKeyword(value);
    setLoading(false);
    setPickingId('');
    setResults(null);
    setError('');
    setSearchWarning('');
    setMore({}); setMoreError(''); setMoreLoading(false); cancelMore();
  };

  useEffect(() => {
    if (!active || !externalQuery || externalQuery === lastExternalQuery.current) return;
    lastExternalQuery.current = externalQuery;
    setKeyword(externalQuery);
    setTimeout(() => { inputRef.current?.form?.requestSubmit?.(); }, 0);
  }, [active, externalQuery]);

  const clearHistory = () => {
    try {
      clearSearchHistory();
      setHistory([]);
      setHistoryError('');
    } catch {
      setHistoryError('搜索历史清除失败，请重试。');
    }
  };

  const removeHistory = (term) => {
    try {
      setHistory(removeSearchTerm(term));
      setHistoryError('');
    } catch {
      setHistoryError('这条搜索历史删除失败，请重试。');
    }
  };

  const doSearch = async () => {
    if (sourcesLoading) return;
    const kw = keyword.trim();
    if (!kw) {
      setError('请输入剧名关键词');
      return;
    }
    const key = JSON.stringify([source, kw]);
    if (pendingSearch.current?.key === key) return;
    const request = ++requestVersion.current;
    pendingSearch.current = { key, request };
    setPickingId('');
    setLoading(true);
    setError('');
    setSearchWarning('');
    setResults(null);
    setPageTitle('');
    setMore({}); setMoreError(''); setMoreLoading(false); cancelMore();
    setSearchedKeyword(kw);
    const sources = source === 'all' ? mediaSources.map(item => item.id) : [source];
    const settled = new Array(sources.length);
    const publishPartial = () => {
      if (request !== requestVersion.current) return;
      const merged = [], nextMore = {};
      sources.forEach((searchSource, index) => {
        const entry = settled[index];
        if (entry?.status !== 'fulfilled') return;
        merged.push(...(entry.value.results || []).map(item => ({ ...item, source: searchSource })));
        if (entry.value.channel && entry.value.channel !== 'dom' && entry.value.hasMore) {
          nextMore[searchSource] = { channel: entry.value.channel, cursor: entry.value.cursor || null, page: entry.value.page || 1, hasMore: true };
        }
      });
      if (merged.length) setResults(rankSearchResults(merged, kw));
      if (sources.length === 1) setPageTitle(settled[0]?.value?.pageTitle || '');
      // Do not offer pagination until every source has settled; otherwise the button can shift under the user.
      if (sources.every((_, index) => settled[index])) setMore(nextMore);
    };
    const applyResponses = (timedOut) => {
      const merged = [], failures = [], warnings = [], nextMore = {};
      sources.forEach((searchSource, index) => {
        const entry = settled[index];
        if (!entry) {
          if (timedOut) failures.push(`${mediaSourceLabel(searchSource, mediaSources)}：搜索超时，未返回结果`);
          return;
        }
        if (entry.status === 'fulfilled') {
          merged.push(...(entry.value.results || []).map(item => ({ ...item, source: searchSource })));
          if (entry.value.partial) warnings.push(`${mediaSourceLabel(searchSource, mediaSources)}：${entry.value.error || '补充搜索未完成，可稍后重试。'}`);
          if (entry.value.meta?.relaxed) warnings.push(`${mediaSourceLabel(searchSource, mediaSources)}：没有完整剧名匹配，已用「${entry.value.meta.relaxedQuery}」补搜。`);
          if (entry.value.meta?.newRelease && entry.value.via !== 'app-new') warnings.push(`${mediaSourceLabel(searchSource, mediaSources)}：官网暂未返回同名结果，已从 App 上新补搜到 ${entry.value.meta.newRelease} 部。`);
          if (sources.length === 1) setPageTitle(entry.value.pageTitle || '');
          if (entry.value.channel && entry.value.channel !== 'dom' && entry.value.hasMore) {
            nextMore[searchSource] = { channel: entry.value.channel, cursor: entry.value.cursor || null, page: entry.value.page || 1, hasMore: true };
          }
        } else {
          failures.push(`${mediaSourceLabel(searchSource, mediaSources)}：${entry.reason?.message || '搜索失败'}`);
        }
      });
      rememberCatalogTitles(merged);
      if (settled.some(entry => entry?.status === 'fulfilled')) {
        try {
          setHistory(saveSearchTerm(kw));
          setHistoryError('');
        } catch {
          setHistoryError('搜索结果已显示，但本机搜索历史保存失败。');
        }
      }
      setResults(rankSearchResults(merged, kw));
      setMore(nextMore);
      setSearchWarning(warnings.join('；'));
      if (failures.length) setError(`${failures.join('；')}。${merged.length ? '已显示其他来源的结果。' : ''}请重试或切换来源。`);
    };
    const safety = setTimeout(() => {
      if (request !== requestVersion.current) return;
      requestVersion.current++;
      pendingSearch.current = null;
      applyResponses(true);
      setLoading(false);
    }, SEARCH_SAFETY_TIMEOUT_MS);
    try {
      // 每个来源完成就记下来；总超时到达时仍能展示已完成来源的结果。
      const responses = await Promise.allSettled(sources.map((searchSource, index) => window.electronAPI.searchSeries(kw, { source: searchSource })
        .then(res => {
          if (!res?.success) throw new Error(res?.error || '搜索失败，请重试');
          const entry = { status: 'fulfilled', value: res };
          settled[index] = entry;
          publishPartial();
          return entry;
        })
        .catch(error => {
          const entry = { status: 'rejected', reason: error };
          settled[index] = entry;
          publishPartial();
          throw error;
        })));
      if (request !== requestVersion.current) return;
      responses.forEach((entry, index) => { settled[index] ||= entry; });
      applyResponses(false);
    } catch (e) {
      if (request !== requestVersion.current) return;
      // allSettled 通常不会 reject；保留防御路径，避免同步异常留下空转圈。
      settled.forEach((entry, index) => { if (!entry) settled[index] = { status: 'rejected', reason: e }; });
      applyResponses(false);
    } finally {
      clearTimeout(safety);
      if (pendingSearch.current?.request === request) pendingSearch.current = null;
      if (request === requestVersion.current) setLoading(false);
    }
  };

  // 选中某部剧 -> 拉取完整分集 -> 交给下载页
  const pick = async (item, viewDetails = false) => {
    const request = ++requestVersion.current;
    pendingSearch.current = null;
    setLoading(false);
    setPickingId(item.series_id);
    setError('');
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (request !== requestVersion.current) return;
      if (res && res.success && res.data) {
        await (viewDetails ? onViewSeries : onSelectSeries)({
          ...res.data,
          cover: res.data.cover || item.cover || '',
          description: [res.data.description, res.data.intro, res.data.series_intro, item.description, item.intro, item.series_intro]
            .find(value => typeof value === 'string' && value.trim())?.trim() || '',
        });
      } else {
        setError((res && res.error) || '拉取分集失败');
      }
    } catch (e) {
      if (request === requestVersion.current) setError('拉取分集异常: ' + e.message);
    } finally {
      if (request === requestVersion.current) setPickingId('');
    }
  };

  const showBrowser = async () => {
    try {
      const term = (searchedKeyword || keyword).trim();
      const sourceUrl = term ? `https://hongguoduanju.com/search/${encodeURIComponent(term)}` : undefined;
      const res = await window.electronAPI.searchWindowShow(true, sourceUrl);
      if (res?.success === false) throw new Error(res.error || '来源页面打开失败');
    } catch (e) { setError(e.message || '来源页面打开失败，请重试'); }
  };

  const loadMore = async () => {
    const entries = Object.entries(more).filter(([, state]) => state.hasMore);
    const kw = searchedKeyword.trim();
    if (!active || sourcesLoading || moreRequest.current || !kw || !entries.length) return;
    const request = { responses: new Map(), timer: null };
    moreRequest.current = request;
    setMoreLoading(true); setMoreError('');
    const finish = (timedOut = false) => {
      if (moreRequest.current !== request) return;
      cancelMore();
      const nextMore = { ...more }, additions = [], errors = [];
      for (const [searchSource, state] of entries) {
        const response = request.responses.get(searchSource);
        if (response?.success) {
          additions.push(...(response.results || []).map(item => ({ ...item, source: searchSource })));
          if (response.hasMore) nextMore[searchSource] = { channel: response.channel || state.channel, cursor: response.cursor || null, page: response.page || state.page + 1, hasMore: true };
          else delete nextMore[searchSource];
        } else {
          errors.push(`${mediaSourceLabel(searchSource, mediaSources)}：${response?.error || (timedOut && !response ? '加载更多超时，请重试' : '加载更多失败')}`);
        }
      }
      if (additions.length) {
        setResults(prev => {
          const map = new Map((prev || []).map(item => [`${item.source}:${item.series_id}`, item]));
          for (const item of additions) map.set(`${item.source}:${item.series_id}`, item);
          return rankSearchResults([...map.values()], kw);
        });
      }
      setMore(nextMore);
      setMoreError(errors.join('；'));
      setMoreLoading(false);
    };
    // Preserve completed sources at the deadline; late IPC replies cannot alter the next request.
    request.timer = setTimeout(() => finish(true), SEARCH_SAFETY_TIMEOUT_MS);
    await Promise.all(entries.map(async ([searchSource, state]) => {
      let response;
      try {
        response = await window.electronAPI.searchSeriesMore(kw, { source: searchSource, channel: state.channel, cursor: state.cursor, page: state.page + 1 });
      } catch (error) { response = { success: false, error: error.message }; }
      if (moreRequest.current === request) request.responses.set(searchSource, response);
    }));
    finish();
  };

  const exactMatches = results ? results.filter(item => item.relevance < 2 && !item.fuzzy) : [];
  const additionalMatches = results ? results.filter(item => item.relevance >= 2 || item.fuzzy) : [];

  const renderResultCard = (item) => {
    const epCount = Number(item.total) || Number(item.episode_count) || 0;
    const isPicking = pickingId === item.series_id;
    const hasMetaLine = epCount > 0 || item.completion_status === 'completed' || item.completion_status === 'ongoing' || Boolean(item.tags?.[0]);
    return (
      <div className="search-card-item" key={`${item.source}:${item.series_id}`}>
        <article
          className={`search-card ${isPicking ? 'picking' : ''}`}
          tabIndex={0}
          onClick={() => pickingId === '' && pick(item)}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && pickingId === '') { e.preventDefault(); pick(item); } }}
          title={`${t(onViewSeries ? '点击播放' : '点击查看并下载')}: ${item.series_title}`}
        >
          <div className="search-cover">
            {item.cover ? (
              <img src={item.cover} alt={item.series_title} loading="lazy" />
            ) : (
              <div className="cover-placeholder"><Film size={22} /></div>
            )}
          </div>
          <div className="search-card-body">
            <div className="search-card-title">{item.series_title}</div>
            <div className="search-card-meta-stack">
              <div className="search-card-badges">
                <span className="sr-badge sr-badge-source">{t(mediaSourceLabel(item.source, mediaSources))}</span>
                {item.tags?.[0] && <span className="sr-badge">{t(item.tags[0])}</span>}
                {item.new_release && <span className="badge-new">{t(item.released_today ? '今日上新' : 'App 新剧')}</span>}
              </div>
              {(epCount > 0 || item.completion_status === 'completed' || item.completion_status === 'ongoing') && (
                <div className="search-card-badges">
                  {epCount > 0 && <span className="sr-badge">{t("{0} 集", [epCount])}</span>}
                  {item.completion_status === 'completed' && <span className="sr-badge">{t("已完结")}</span>}
                  {item.completion_status === 'ongoing' && <span className="sr-badge">{t("更新中")}</span>}
                </div>
              )}
            </div>
            <div className="search-card-actions">
              <button
                type="button"
                className="btn btn-outline btn-sm sr-view-btn"
                disabled={pickingId !== ''}
                onClick={(e) => { e.stopPropagation(); if (pickingId === '') pick(item); }}
              >
                {isPicking ? <><RefreshCw size={13} className="spin" /><span>{t("正在拉取分集…")}</span></>
                  : <><Eye size={13} /><span>{t("查看剧集")}</span></>}
              </button>
            </div>
          </div>
        </article>
        {onViewSeries && <button className="mobile-drama-details" disabled={pickingId !== ''} aria-label={t(`详情与下载：${item.series_title}`)} onClick={() => pick(item, true)}>{t("详情与下载")}</button>}
      </div>
    );
  };

  return (
    <div className="hongguo-card sr-panel">
      {sourcesError && <p className="settings-hint" role="status">{t("来源列表更新失败，暂用上次列表；可在设置重新保存来源后重试。")}</p>}

      {/* 2. Single-row Search Controls */}
      <div className="input-group sr-search-row">
        <div className="unified-input-wrap">
          {loading
            ? <RefreshCw size={15} className="spin unified-input-icon is-loading" />
            : <Search size={15} className="unified-input-icon" />}
          <input
            type="text"
            className={`input-field sr-search-input ${loading ? 'has-inline-loading' : ''} ${keyword ? 'has-value' : ''}`}
            aria-label={t("搜索短剧名称")}
            ref={inputRef}
            list="local-search-suggestions"
            autoComplete="off"
            placeholder={t("输入剧名，例如：一村人养一个神")}
            value={keyword}
            onChange={(e) => changeKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (!isSubmitKey(e)) return;
              const trimmed = keyword.trim();
              if (onResolveInput && (/^https?:\/\//i.test(trimmed) || /^\d{5,30}$/.test(trimmed) || /series_id=\d+/i.test(trimmed))) {
                onResolveInput(trimmed);
              } else {
                doSearch();
              }
            }}
          />
          {loading && (
            <span className="sr-inline-loading" role="status">{t("正在寻找相关短剧，首次加载可能需要几秒…")}</span>
          )}
          {!keyword && !loading && (
            <ChevronDown size={14} className="sr-datalist-arrow" />
          )}
          {keyword && !loading && (
            <button type="button" className="unified-clear-btn" aria-label={t("清空")} title={t("清空")} onClick={() => { changeKeyword(''); inputRef.current?.focus(); }}>
              <X size={14} />
            </button>
          )}
        </div>
        <select className="input-field sr-source-select" aria-label={t("短剧来源")} value={source} onChange={(e) => switchSource(e.target.value)}>
          <option value="all">{t("全部来源")}</option>
          {mediaSources.map(({ id, label }) => <option key={id} value={id}>{id.startsWith('custom:') ? label : t(label)}</option>)}
        </select>
        <button type="button" className="btn btn-outline" disabled={loading} onClick={async () => {
          try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text || text.length > 4096) return;
            changeKeyword(text);
            if (onResolveInput && (/^https?:\/\//i.test(text) || /^\d{5,30}$/.test(text) || /series_id=\d+/i.test(text))) {
              onResolveInput(text);
            }
          } catch {}
        }}>{t("粘贴链接")}</button>
        <button className="btn btn-primary" onClick={() => {
          const trimmed = keyword.trim();
          if (onResolveInput && (/^https?:\/\//i.test(trimmed) || /^\d{5,30}$/.test(trimmed) || /series_id=\d+/i.test(trimmed))) {
            onResolveInput(trimmed);
          } else {
            doSearch();
          }
        }} disabled={loading || sourcesLoading}>
          {loading ? (
            <><RefreshCw size={15} className="spin" /><span>{t("搜索中...")}</span></>
          ) : (
            <><Search size={15} /><span>{t("搜索")}</span></>
          )}
        </button>
      </div>
      <datalist id="local-search-suggestions">
        {suggestions.map(({ term, source: origin }) => <option key={term} value={term} label={origin} />)}
      </datalist>

      {results === null && !loading && !error && !compactWelcome && (
        <div className="search-welcome"><Search size={32} /><h3>{t("好故事，从一个名字开始")}</h3><p>{t("输入完整剧名或关键词，发现你想看的短剧。")}</p></div>
      )}
      {error && <div className="alert alert-error" role="alert">{t(error)}</div>}
      {searchWarning && <p className="settings-hint" role="status">{t(searchWarning)}{t(" 已显示本次查到的结果。")}</p>}

      {results && results.length === 0 && !loading && !error && (
        <div className="search-empty">
          <p>{t("没有找到相关短剧")}{t(pageTitle ? `（页面标题：${pageTitle}）` : '')}</p>
          <div className="search-empty-actions">
            {source === 'hongguo' && <button className="btn btn-outline" onClick={showBrowser}><ExternalLink size={15} />{t("打开来源页面")}</button>}
            {source === 'hongguo' && onSwitchToInput && <button className="btn btn-outline" onClick={onSwitchToInput}>{t("改用链接 / ID 下载")}</button>}
          </div>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="sr-results-wrap">
          {/* 4. Results Header */}
          <div className="sr-results-header">
            <div className="sr-results-summary">
              <span className="sr-results-count">{t("找到 ")}{results.length}{t(" 部标题匹配短剧")}</span>
              {searchedKeyword && <span className="sr-keyword-pill">“{searchedKeyword}”</span>}
            </div>
          </div>

          {exactMatches.length > 0 && (
            <>
              {additionalMatches.length > 0 && <div className="sr-section-label">{t("搜索短剧")} ({exactMatches.length})</div>}
              <div className="search-grid">
                {exactMatches.map(renderResultCard)}
              </div>
            </>
          )}

          {additionalMatches.length > 0 && (
            <>
              <div className="sr-section-label">
                {t("补搜结果 · 查看剧集").split('·')[0].trim()} ({additionalMatches.length})
              </div>
              <div className="search-grid">
                {additionalMatches.map(renderResultCard)}
              </div>
            </>
          )}

          {Object.values(more).some(state => state.hasMore) && (
            <div className="search-more">
              <button type="button" className="btn btn-outline btn-sm" disabled={moreLoading} onClick={loadMore}>
                {t(moreLoading ? '加载中…' : '加载更多')}
              </button>
              {moreError && <span role="alert">{t(moreError)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SearchPanel;
