import { t, useLanguage } from '../i18n';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './Browse.css';
import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { Film, RefreshCw, ExternalLink, Download, Play, Check, X, Search, Heart, Eye, LayoutGrid, List, SlidersHorizontal, RotateCcw, ChevronLeft, ChevronRight, ChevronDown, Flame } from './icons';
import { isSubmitKey, parseEpisodeRange } from './episodeRange';
import { rememberCatalogTitles } from '../searchHistory';
import { readLocalLibrary, saveLocalSeries, subscribeLocalLibrary } from '../localLibrary';

const PAGE_CACHE_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 25_000;
const PAGE_CACHE_KEY = 'hongguo.catalog.page.v1';
const CATALOG_CHANNEL_KEY = 'hongguo.catalog.channel.v1';
const PAGE_CACHE_MAX = 8;
const PAGE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VIEW_MODE_KEY = 'hongguo:discover-view';

function readFavorites() {
  return new Set(readLocalLibrary().items.filter(item => item.favorite).map(item => String(item.id)));
}

function readPageCacheFile() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const parsed = JSON.parse(localStorage.getItem(PAGE_CACHE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - PAGE_CACHE_MAX_AGE_MS;
    return parsed.filter(entry => entry && typeof entry.key === 'string' && Array.isArray(entry.results)
      && Number(entry.savedAt) >= cutoff).slice(0, PAGE_CACHE_MAX);
  } catch (_) { return []; }
}

function readPersistedPage(key) {
  return readPageCacheFile().find(entry => entry.key === key) || null;
}

function writePersistedPage(key, page) {
  try {
    if (typeof localStorage === 'undefined') return;
    const entries = readPageCacheFile().filter(entry => entry.key !== key);
    entries.unshift({ key, ...page });
    localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(entries.slice(0, PAGE_CACHE_MAX)));
  } catch (_) { /* quota or disabled storage: memory cache still works */ }
}

/**
 * Browse —— 分类淘剧
 *
 * 数据链路：
 *   独立来源目录 -> 卡片(series_id/剧名/封面/集数/标签)
 *   点卡片 -> 复用 search-resolve 拉全集并写入短剧档案
 *         -> 复用 get-series-episodes 拿到每集「已下载/下载中/未下载」状态
 *         -> 跳播放器 或 走既有批量下载
 */
function Browse({ onNavigate, active = true }) {
  useLanguage();
  const mobile = window.electronAPI.platform === 'android';
  const FilterContainer = mobile ? 'details' : 'div';
  const [selectingDownloads, setSelectingDownloads] = useState(false);
  const [source, setSource] = useState('hongguo');
  const [catalogChannel, setCatalogChannel] = useState(() => {
    try { return localStorage.getItem(CATALOG_CHANNEL_KEY) === 'web' ? 'web' : 'app'; }
    catch (_) { return 'app'; }
  });
  const appCatalog = source === 'hongguo' && catalogChannel === 'app';
  const { sources: mediaSources, revision: sourceRevision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('real-drama');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);
  const [completion, setCompletion] = useState('all');

  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0, genres: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshNotice, setRefreshNotice] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });
  const [sortBy, setSortBy] = useState('default');
  const [selectedGenres, setSelectedGenres] = useState([]);
  const [genreMenuOpen, setGenreMenuOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [favorites, setFavorites] = useState(readFavorites);
  const genreDropdownRef = useRef(null);

  // 详情抽屉
  const [detail, setDetail] = useState(null); // { series_id, series_title, cover, episodes: [...] }
  const [detailLoading, setDetailLoading] = useState(false);
  const [openingId, setOpeningId] = useState('');
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);
  const detailRequest = useRef(0);
  const listRequest = useRef(0);
  const loadingRequest = useRef(0);
  const pageCache = useRef(new Map()).current;
  const discoveryPages = useRef(new Map()).current;
  const refreshFirstPage = useRef(false);
  const refreshToFirstPage = useRef(false);
  const viewRef = useRef({ source: '', category: '', channel: '', genre: '', page: 0 });
  const resultsRef = useRef(results);
  const listTimer = useRef(null);
  const toastTimer = useRef(null);
  resultsRef.current = results;

  const invalidateList = useCallback(() => {
    if (mobile) { detailRequest.current++; setOpeningId(''); }
    listRequest.current++;
    loadingRequest.current = 0;
    clearTimeout(listTimer.current);
    // A cleanup can invalidate a request without starting a replacement. Clear the
    // skeleton here; a subsequent loadList immediately claims the token and shows it again.
    setLoading(false);
  }, []);

  const cancelList = () => {
    invalidateList();
    loadingRequest.current = 0;
    setLoading(false);
    setError('已取消加载，可重新加载或切换分类。');
  };

  const closeDetail = useCallback(() => {
    detailRequest.current++;
    setDetail(null);
    setDetailLoading(false);
    setOpeningId('');
  }, []);

  useEffect(() => { if (!active) closeDetail(); }, [active, closeDetail]);

  useEffect(() => () => {
    detailRequest.current++;
    invalidateList();
    clearTimeout(toastTimer.current);
  }, [invalidateList]);

  // 已下载统计（按 series_id -> 已下载集数）
  const [downloadedMap, setDownloadedMap] = useState({});
  const [toast, setToast] = useState(null);

  const showToast = useCallback((text, type = 'success') => {
    setToast({ text, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const loadDownloadedMap = useCallback(async () => {
    try {
      const list = (await window.electronAPI.getSeriesList()) || [];
      const map = {};
      for (const s of list) {
        const res = await window.electronAPI.getSeriesEpisodes(s.series_id);
        if (res && res.success) {
          map[String(s.series_id)] = {
            completed: res.data.completedCount,
            total: res.data.total,
          };
        }
      }
      setDownloadedMap(map);
    } catch (_) {}
  }, []);

  const loadCategories = useCallback(async () => {
    try {
      const list = await window.electronAPI.browseCategories();
      if (Array.isArray(list) && list.length) {
        setCategories(list);
      }
    } catch (_) {}
  }, []);

  const loadList = useCallback(
    async (cat, gen, pg, forceRefresh = false) => {
      invalidateList();
      const request = listRequest.current;
      const channel = source === 'hongguo' ? catalogChannel : '';
      const key = JSON.stringify([sourceRevision, source, channel, cat, gen, pg]);
      const persistedKey = JSON.stringify([source, channel, cat, gen, pg]);
      const queryKey = JSON.stringify([source, channel, cat, gen]);
      const previousBatch = discoveryPages.get(queryKey);
      // First-page App cards are safe to show as a stale preview; page 2+ depends on a live cursor.
      const canPersist = !source.startsWith('custom:') && (!appCatalog || pg === 1);
      let cached = pageCache.get(key);
      if (!cached && canPersist) {
        cached = readPersistedPage(persistedKey);
        if (cached) pageCache.set(key, cached);
      }
      const sameView = viewRef.current.source === source && viewRef.current.category === cat && viewRef.current.channel === channel;
      const sameQuery = sameView && viewRef.current.genre === gen;
      const samePage = viewRef.current.page === pg;
      const resettingToFirstPage = forceRefresh && refreshToFirstPage.current;
      viewRef.current = { source, category: cat, channel, genre: gen, page: pg };
      // A stale App first page is a useful cold-start preview, but must not replace the
      // page the user is already on when refreshing another page or after an expired back.
      const useCached = cached && (!appCatalog || !sameView || samePage);
      const fallbackUrl = source === 'hongguo' && catalogChannel === 'web'
        ? `https://hongguoduanju.com/${cat.startsWith('hot-') ? 'rank' : 'category'}/${encodeURIComponent(cat)}${gen ? `/${encodeURIComponent(gen)}` : ''}${pg > 1 ? `?page=${pg}` : ''}` : '';
      setUnsupported(false);
      setError('');
      setRefreshNotice('');
      const previousResults = forceRefresh && !resettingToFirstPage && sameQuery && samePage && resultsRef.current.length
        ? resultsRef.current : null;
      // Keep the current grid during a genre/page refresh instead of replacing it with skeletons.
      if (useCached) {
        setResults(cached.results);
        setMeta({ ...cached.meta, page: pg });
        setSourceUrl(cached.sourceUrl || fallbackUrl);
      } else {
        setResults(prev => previousBatch?.results || (sameView ? prev : []));
        setMeta(prev => previousBatch?.meta || (sameView ? prev : { total: 0, totalPages: 0, genres: [] }));
        setSourceUrl(prev => sameView ? prev : fallbackUrl);
      }
      if (!forceRefresh && cached && !appCatalog && Date.now() - cached.savedAt < PAGE_CACHE_TTL_MS) {
        setLoading(false);
        return;
      }
      setLoading(true);
      // A new query or App first-page request may replace the old cursor chain even without forceRefresh.
      if ((!sameQuery && !previousBatch) || (appCatalog && (forceRefresh || pg === 1))) setMeta(prev => ({ ...prev, cursorExpired: true }));
      loadingRequest.current = request;
      listTimer.current = setTimeout(() => {
        // A cleanup can invalidate the request without starting another load (e.g. while
        // source metadata is still loading). Never leave the skeleton spinning forever.
        if (loadingRequest.current !== request) return;
        loadingRequest.current = 0;
        invalidateList();
        setLoading(false);
        setError(cached ? '刷新超时，仍显示上次片单；可重试或切换分类。' : '加载超时，请重试或切换分类。');
      }, LIST_TIMEOUT_MS);
      try {
        const res = await window.electronAPI.browseList({ source, category: cat, genre: gen, page: pg, forceRefresh,
          ...(source === 'hongguo' ? { catalogChannel } : {}), ...(appCatalog ? { catalogScope: 'browse' } : {}) });
        if (request !== listRequest.current) return;
        setSourceUrl(res?.sourceUrl || fallbackUrl);
        if (appCatalog && res?.code === 'APP_CURSOR') {
          setMeta(prev => ({ ...prev, cursorExpired: true }));
          throw new Error('分页记录已失效，请点击“刷新片单”返回第一页。');
        }
        if (!res?.success) throw new Error(res?.error || '来源暂时不可用');
        const next = {
          results: Array.isArray(res.results) ? res.results : [],
          meta: { page: pg, total: res.total || 0, totalPages: res.totalPages || 0, genres: res.genres || [], hasMore: res.hasMore === true },
          sourceUrl: res.sourceUrl || fallbackUrl,
          savedAt: Date.now(),
        };
        if (!next.results.length && (cached || previousBatch) && res.unsupported !== true) {
          throw new Error(res.emptyMessage || '来源这次没有返回片单，请稍后重试。');
        }
        rememberCatalogTitles(next.results);
        setResults(next.results);
        setMeta(next.meta);
        setSourceUrl(next.sourceUrl);
        if (next.results.length) {
          if (!cat.startsWith('hot-')) {
            discoveryPages.delete(queryKey);
            discoveryPages.set(queryKey, next);
            if (discoveryPages.size > 24) discoveryPages.delete(discoveryPages.keys().next().value);
          }
          refreshToFirstPage.current = false;
          if (resettingToFirstPage) {
            setRefreshNotice(`已重新获取 ${next.results.length} 部短剧，已返回第一页。`);
          } else if (forceRefresh && previousResults) {
            const sameOrder = previousResults.length === next.results.length
              && previousResults.every((item, index) => String(item.series_id) === String(next.results[index]?.series_id));
            setRefreshNotice(sameOrder
              ? cat.startsWith('hot-')
                ? `刷新完成：来源榜单顺序未变化（${next.results.length} 部）。`
                : `刷新完成：来源返回的短剧及顺序未变化（${next.results.length} 部）。`
              : `刷新完成：片单已更新（${next.results.length} 部）。`);
          }
          if (!appCatalog || pg === 1) {
            pageCache.delete(key);
            pageCache.set(key, next);
            if (canPersist) writePersistedPage(persistedKey, next);
            if (pageCache.size > 24) pageCache.delete(pageCache.keys().next().value);
          }
        } else {
          if (!appCatalog) pageCache.delete(key);
          setUnsupported(res.unsupported === true);
          setError(res.emptyMessage || '这一页没有取到内容，可重新加载或换分类。');
        }
      } catch (e) {
        if (request !== listRequest.current) return;
        setError(`${sameView && !sameQuery ? '加载失败，仍显示切换前片单' : cached ? '刷新失败，仍显示上次片单' : '加载失败'}：${e.message || '请重试'}`);
      } finally {
        if (loadingRequest.current === request) {
          loadingRequest.current = 0;
          clearTimeout(listTimer.current);
          setLoading(false);
        }
      }
    },
    [invalidateList, source, sourceRevision, catalogChannel, appCatalog, pageCache, discoveryPages]
  );

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => { if (active) loadDownloadedMap(); }, [active, loadDownloadedMap]);

  useEffect(() => {
    invalidateList(); closeDetail(); pageCache.clear(); discoveryPages.clear();
    refreshFirstPage.current = false;
    refreshToFirstPage.current = false;
    setGenre(''); setPage(1); setResults([]); setMeta({ total: 0, totalPages: 0, genres: [] });
    setRefreshNotice('');
    if (!mediaSources.some(item => item.id === source)) { setSource('hongguo'); setCategory('real-drama'); }
  }, [sourceRevision, mediaSources, invalidateList, closeDetail, discoveryPages]);

  useEffect(() => {
    if (active && !sourcesLoading && mediaSources.some(item => item.id === source)) {
      const forceRefresh = refreshFirstPage.current;
      refreshFirstPage.current = false;
      loadList(category, genre, page, forceRefresh);
    }
    return invalidateList;
  }, [active, category, genre, page, loadList, sourcesLoading, mediaSources, invalidateList]);

  const refreshList = () => {
    if (appCatalog && page > 1) {
      invalidateList();
      refreshFirstPage.current = true;
      refreshToFirstPage.current = true;
      setPage(1);
    } else {
      return loadList(category, genre, page, true);
    }
  };

  const retryList = () => meta.cursorExpired
    ? refreshList()
    : loadList(category, genre, page, !appCatalog);

  const switchCatalogChannel = (next) => {
    if (!['app', 'web'].includes(next) || next === catalogChannel) return;
    invalidateList(); closeDetail();
    refreshFirstPage.current = false;
    refreshToFirstPage.current = false;
    setCatalogChannel(next);
    setGenre(''); setPage(1); setCompletion('all');
    setResults([]); setMeta({ total: 0, totalPages: 0, genres: [] });
    setSourceUrl(''); setError(''); setRefreshNotice(''); setUnsupported(false);
    try { localStorage.setItem(CATALOG_CHANNEL_KEY, next); } catch (_) { /* selection still works for this launch */ }
  };

  const switchSource = (next) => {
    if (next === source) return;
    invalidateList();
    closeDetail();
    refreshFirstPage.current = false;
    refreshToFirstPage.current = false;
    setSource(next);
    setCategory('real-drama');
    setGenre('');
    setPage(1);
    setResults([]);
    setMeta({ total: 0, totalPages: 0, genres: [] });
    setSourceUrl('');
    setError('');
    setRefreshNotice('');
  };

  const selectDiscoveryBatch = (cat, gen) => {
    const sameQuery = cat === category && gen === genre;
    if (sameQuery && loading) return;
    const previous = discoveryPages.get(JSON.stringify([source, source === 'hongguo' ? catalogChannel : '', cat, gen]))?.meta;
    const hasMore = previous && (previous.totalPages ? previous.page < previous.totalPages : previous.hasMore);
    const next = sameQuery && meta.cursorExpired ? 1 : hasMore ? previous.page + 1 : 1;
    refreshToFirstPage.current = false;
    if (sameQuery && next === page) return loadList(cat, gen, next, next === 1 || !appCatalog);
    invalidateList();
    refreshFirstPage.current = next === 1;
    setError(''); setRefreshNotice('');
    if (cat !== category) {
      setResults([]); setMeta({ total: 0, totalPages: 0, genres: [] });
    }
    setCategory(cat); setGenre(gen); setPage(next);
  };

  const switchCategory = (slug) => {
    if (!slug.startsWith('hot-') && slug !== 'comic') return selectDiscoveryBatch(slug, '');
    if (slug === category) return;
    invalidateList();
    refreshFirstPage.current = false;
    refreshToFirstPage.current = false;
    setError('');
    setRefreshNotice('');
    setMeta({ total: 0, totalPages: 0, genres: [] });
    setCategory(slug);
    setGenre('');
    setPage(1);
    setResults([]);
  };

  const switchGenre = (slug) => {
    if (!category.startsWith('hot-') && category !== 'comic') return selectDiscoveryBatch(category, slug);
    if (slug === genre) return;
    invalidateList();
    refreshToFirstPage.current = false;
    setError('');
    setRefreshNotice('');
    setGenre(slug);
    setPage(1);
    // loadList keeps the previous grid visible until the new genre arrives.
  };

  const gotoPage = (p) => {
    if (meta.cursorExpired) return;
    const max = meta.totalPages || (meta.page || page) + (meta.hasMore ? 1 : 0);
    const next = Math.min(Math.max(1, p), max);
    if (next === page) {
      if (error) loadList(category, genre, next);
      return;
    }
    invalidateList();
    setError('');
    setRefreshNotice('');
    setPage(next);
    document.querySelector('.main-content:not([hidden])')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ===== 打开某部剧 =====
  const openSeries = async (item, play = mobile) => {
    setSelectingDownloads(false);
    const request = ++detailRequest.current;
    setDetailLoading(!play);
    setOpeningId(play ? item.series_id : '');
    setDetail(null);
    setSelectedIdx(new Set());
    setRangeInput('');
    setRangeError('');
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (request !== detailRequest.current) return;
      if (!res || !res.success) {
        showToast((res && res.error) || '拉取分集失败', 'error');
        return;
      }
      const data = res.data;
      if (play) {
        const first = data.episodes.find(ep => !ep.locked);
        if (!first) throw new Error('来源尚未开放可播放集数');
        const opened = await window.electronAPI.playSeries({ seriesId: data.series_id, resume: true });
        if (request !== detailRequest.current) return;
        if (!opened?.success) throw new Error(opened?.error || '打开播放器失败，请重试');
        return;
      }
      // 合并下载状态
      const epRes = await window.electronAPI.getSeriesEpisodes(item.series_id);
      if (request !== detailRequest.current) return;
      const statusMap = {};
      if (epRes && epRes.success) {
        for (const e of epRes.data.episodes) statusMap[e.vid_index] = e;
      }
      const episodes = data.episodes.map((ep) => ({
        ...ep,
        status: statusMap[ep.vid_index] ? statusMap[ep.vid_index].status : 'missing',
        progress: statusMap[ep.vid_index] ? statusMap[ep.vid_index].progress : 0,
        fileUrl: statusMap[ep.vid_index] ? statusMap[ep.vid_index].fileUrl : null,
      }));
      setDetail({ ...data, episodes, completedCount: episodes.filter((e) => e.status === 'completed').length });
      // 默认全选未下载的
      setSelectedIdx(new Set(episodes.filter((e) => !e.locked && e.status !== 'completed').map((e) => e.vid_index)));
    } catch (e) {
      if (request === detailRequest.current) showToast('打开失败: ' + e.message, 'error');
    } finally {
      if (request === detailRequest.current) { setDetailLoading(false); setOpeningId(''); }
    }
  };

  const toggleIdx = (idx) => {
    if (!detail?.episodes.some((ep) => ep.vid_index === idx && !ep.locked)) return;
    const next = new Set(selectedIdx);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelectedIdx(next);
  };

  // 区间快选：1-50 / 前10 / 后30 / 全选 / 清空
  const applyRange = (expr) => {
    if (!detail) return;
    try {
      const nums = parseEpisodeRange(expr, detail.episodes.length);
      setSelectedIdx(new Set(detail.episodes.filter((e) => !e.locked && nums.has(e.vid_index)).map((e) => e.vid_index)));
      setRangeError('');
    } catch (error) { setRangeError(error.message); }
  };

  const downloadSelected = async () => {
    if (!detail || selectedIdx.size === 0) return;
    const request = detailRequest.current;
    setSubmitting(true);
    try {
      const eps = detail.episodes.filter((e) => !e.locked && selectedIdx.has(e.vid_index));
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: detail.series_id,
        seriesTitle: detail.series_title,
        episodes: eps,
      });
      if (res && res.success) {
        showToast(`已加入下载队列：${res.count} 集`);
        // A stale success must not close a newer drawer or force navigation after the
        // user closed the detail, opened another series, or left the page.
        if (request === detailRequest.current) {
          setDetail(null);
          if (onNavigate) onNavigate('manager');
        }
      } else {
        showToast((res && res.error) || '提交下载失败', 'error');
      }
    } catch (e) {
      showToast('提交异常: ' + e.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // 从第一集开始；播放器按实际状态选择本地或在线片源。
  const playNow = async (vidIndex) => {
    if (!detail) return;
    const first = detail.episodes.find((e) => !e.locked && (typeof vidIndex !== 'number' || e.vid_index === vidIndex));
    if (!first) return;
    try {
      const res = await window.electronAPI.playSeries({ seriesId: detail.series_id, vidIndex: first.vid_index });
      if (res?.success) closeDetail();
      else showToast(res?.error || '打开播放器失败，请重试', 'error');
    } catch (e) {
      showToast('打开播放器失败: ' + e.message, 'error');
    }
  };

  const showBrowser = async () => {
    if (source !== 'hongguo' || !sourceUrl) return;
    try {
      const res = await window.electronAPI.searchWindowShow(true, sourceUrl);
      if (res?.success === false) throw new Error(res.error || '来源页面打开失败');
      showToast('已打开当前来源页面');
    } catch (e) { showToast(e.message || '来源页面打开失败', 'error'); }
  };

  useDialogKeyboard(active && (!!detail || detailLoading), closeDetail, '.browse-drawer');

  useEffect(() => {
    if (!active) return undefined;
    const onRefresh = (event) => {
      if (!event?.detail?.page || event.detail.page === 'browse') refreshList();
    };
    window.addEventListener('hongguo:refresh-page', onRefresh);
    return () => window.removeEventListener('hongguo:refresh-page', onRefresh);
  });

  useEffect(() => {
    if (!genreMenuOpen) return undefined;
    const onPointerDown = (event) => {
      if (genreDropdownRef.current && !genreDropdownRef.current.contains(event.target)) setGenreMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setGenreMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [genreMenuOpen]);

  useEffect(() => subscribeLocalLibrary((lib) => {
    setFavorites(new Set(lib.items.filter(item => item.favorite).map(item => String(item.id))));
  }), []);

  const toggleFavorite = (item, event) => {
    event?.stopPropagation();
    const id = String(item.series_id);
    const nextFav = !favorites.has(id);
    const saved = saveLocalSeries({ id, title: item.series_title, cover: item.cover || '', favorite: nextFav });
    if (saved.error) showToast(saved.error, 'error');
    else setFavorites(new Set(saved.items.filter(entry => entry.favorite).map(entry => String(entry.id))));
  };

  const changeViewMode = (mode) => {
    setViewMode(mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch {}
  };

  const toggleGenreOption = (slug) => {
    setSelectedGenres((prev) => {
      const next = prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug];
      const primary = next[0] || '';
      if (primary !== genre) switchGenre(primary);
      return next;
    });
  };

  const resetFilters = () => {
    setGenreMenuOpen(false);
    setSelectedGenres([]);
    setCompletion('all');
    setSortBy('default');
    if (source !== 'hongguo') {
      switchSource('hongguo');
    } else if (genre !== '') {
      switchGenre('');
    }
  };

  const applyFilters = () => {
    setGenreMenuOpen(false);
    loadList(category, selectedGenres[0] || genre, 1, true);
  };

  const visibleResults = useMemo(() => {
    let list = completion === 'all' ? results : results.filter((item) => item.completion_status === completion);
    if (selectedGenres.length > 1) {
      const labels = selectedGenres.map(s => meta.genres.find(g => g.slug === s)?.label).filter(Boolean);
      if (labels.length > 1) {
        const filtered = list.filter(item => !item.tags?.length || labels.some(l => item.tags.includes(l)));
        if (filtered.length > 0) list = filtered;
      }
    }
    if (sortBy === 'episodes') {
      return [...list].sort((a, b) => (Number(b.episode_count) || 0) - (Number(a.episode_count) || 0));
    }
    if (sortBy === 'title') {
      return [...list].sort((a, b) => String(a.series_title || '').localeCompare(String(b.series_title || '')));
    }
    if (sortBy === 'rank') {
      return [...list].sort((a, b) => (Number(a.rank) || 9999) - (Number(b.rank) || 9999));
    }
    return list;
  }, [results, completion, selectedGenres, meta.genres, sortBy]);
  // Keep the label and navigation anchored to the cards that actually loaded.
  const displayedPage = meta.page || page;
  const totalPages = meta.totalPages || 0;
  const hasNextBatch = results.length > 0 && (totalPages ? displayedPage < totalPages : meta.hasMore);
  const pageNumbers = useMemo(() => {
    if (!totalPages) return [];
    const out = [];
    const cur = displayedPage;
    const push = (n) => {
      if (n >= 1 && n <= totalPages && !out.includes(n)) out.push(n);
    };
    out.push(1);
    for (let i = cur - 1; i <= cur + 1; i++) push(i);
    if (totalPages >= 5) {
      for (let i = 1; i <= Math.min(5, totalPages); i++) push(i);
    }
    push(totalPages);
    return out.sort((a, b) => a - b);
  }, [totalPages, displayedPage]);

  const primaryCategories = useMemo(() => {
    const base = (categories.length ? categories : [
      { slug: 'real-drama', label: '真人剧' },
      { slug: 'comic-drama', label: '漫剧' },
      { slug: 'ai-drama', label: 'AI剧' },
      { slug: 'comic', label: '漫画' },
    ]).filter(c => !c.slug.startsWith('hot-'));
    return base;
  }, [categories]);

  const trendingCategories = useMemo(() => {
    return (categories.length ? categories : [
      { slug: 'hot-all', label: '综合热播榜' },
      { slug: 'hot-real', label: '真人热播榜' },
      { slug: 'hot-comic', label: '漫剧热播榜' },
      { slug: 'hot-ai', label: 'AI 热播榜' },
    ]).filter(c => c.slug.startsWith('hot-'));
  }, [categories]);

  const activeCategoryLabel = categories.find(c => c.slug === category)?.label || '真人剧';

  return (
    <div className="browse-container">
      {/* 3. Main Category Navigation (42-44px segmented bar) */}
      {source === 'hongguo' && (
        <div className="browse-nav-stack">
          <div className="browse-segmented-bar" role="tablist" aria-label={t("短剧分类")}>
            {primaryCategories.map((c) => (
              <button
                key={c.slug}
                type="button"
                role="tab"
                aria-selected={category === c.slug}
                className={`browse-seg-item ${category === c.slug ? 'active' : ''}`}
                onClick={() => switchCategory(c.slug)}
              >
                {t(c.label)}
              </button>
            ))}
          </div>

          {/* 4. Trending Navigation (compact secondary underline tab bar) */}
          {trendingCategories.length > 0 && (
            <div className="browse-trending-bar" role="tablist" aria-label={t("热播榜单")}>
              <span className="browse-trending-label"><Flame size={14} />{t("热播榜")}</span>
              {trendingCategories.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  role="tab"
                  aria-selected={category === c.slug}
                  className={`browse-trend-tab ${category === c.slug ? 'active' : ''}`}
                  onClick={() => switchCategory(c.slug)}
                >
                  {t(c.label)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 5. Compact Single-Row Filter Toolbar */}
      <FilterContainer className={mobile ? 'mobile-browse-filters' : 'browse-filter-toolbar-wrap'}>
        {mobile && <summary>{t("筛选题材与状态")}{genre && <> · {t(meta.genres.find(item => item.slug === genre)?.label || '')}</>}{completion !== 'all' && <> · {t(completion === 'completed' ? '已完结' : '更新中')}</>}</summary>}
        <div className="browse-filter-toolbar">
          {(!mobile || mediaSources.length > 1) && (
            <label className="filter-pill">
              <span>{t("来源")}</span>
              <select aria-label={t("短剧来源")} value={source} onChange={(e) => switchSource(e.target.value)}>
                {mediaSources.map(({ id, label }) => <option key={id} value={id}>{id.startsWith('custom:') ? label : t(label)}</option>)}
              </select>
            </label>
          )}

          {source === 'hongguo' && (
            <div className="filter-route-seg" role="group" aria-label={t("红果目录线路")}>
              <button type="button" className={catalogChannel === 'app' ? 'active' : ''} onClick={() => switchCatalogChannel('app')}>{t("App目录")}</button>
              <button type="button" className={catalogChannel === 'web' ? 'active' : ''} onClick={() => switchCatalogChannel('web')}>{t("官网目录")}</button>
            </div>
          )}

          {meta.genres.length > 0 && (
            <div className="filter-genre-dropdown" ref={genreDropdownRef}>
              <button
                type="button"
                className={`filter-pill filter-pill-btn ${genreMenuOpen || selectedGenres.length > 0 || genre ? 'active' : ''}`}
                aria-expanded={genreMenuOpen}
                onClick={() => setGenreMenuOpen(open => !open)}
              >
                <span>{t("分类")}</span>
                <b>
                  {selectedGenres.length > 1
                    ? `${selectedGenres.length}`
                    : t(meta.genres.find(g => g.slug === (selectedGenres[0] || genre))?.label || (source === 'xifan' ? '默认分类' : '全部'))}
                </b>
                <ChevronDown size={14} />
              </button>
              {genreMenuOpen && (
                <div className="filter-genre-menu" role="menu">
                  <button
                    type="button"
                    className={`filter-genre-option ${!genre && selectedGenres.length === 0 ? 'selected' : ''}`}
                    onClick={() => { setSelectedGenres([]); switchGenre(''); setGenreMenuOpen(false); }}
                  >
                    <span>{t(source === 'xifan' ? '默认分类' : '全部')}</span>
                    {!genre && selectedGenres.length === 0 && <Check size={13} />}
                  </button>
                  {meta.genres.map((g) => {
                    const checked = selectedGenres.includes(g.slug) || genre === g.slug;
                    return (
                      <button
                        key={g.slug}
                        type="button"
                        className={`filter-genre-option ${checked ? 'selected' : ''}`}
                        onClick={() => toggleGenreOption(g.slug)}
                      >
                        <span>{t(g.label)}</span>
                        {checked && <Check size={13} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <label className="filter-pill">
            <span>{t("剧集状态")}</span>
            <select id="browse-completion" value={completion} onChange={(event) => setCompletion(event.target.value)} aria-label={t("剧集状态")}>
              <option value="all">{t("全部")}</option>
              <option value="ongoing">{t("更新中")}</option>
              <option value="completed">{t("已完结")}</option>
            </select>
          </label>

          <div className="filter-toolbar-actions">
            <button type="button" className="btn btn-outline btn-sm" onClick={resetFilters}>
              <RotateCcw size={13} />{t("恢复默认")}
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={loading || sourcesLoading} onClick={applyFilters}>
              {t("应用")}
            </button>
            <button type="button" className={`btn btn-outline btn-sm ${advancedOpen ? 'is-open' : ''}`} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(v => !v)}>
              <SlidersHorizontal size={13} />{t("筛选题材与状态")}
            </button>
          </div>
        </div>

        {/* Collapsible Advanced Filter Panel */}
        {advancedOpen && (
          <div className="browse-advanced-panel">
            {meta.genres.length > 0 && (
              <div className="browse-genres">
                <button className={`genre-chip ${genre === '' ? 'active' : ''}`} onClick={() => { setSelectedGenres([]); switchGenre(''); }}>
                  {t(source === 'xifan' ? '默认分类' : '全部')}
                </button>
                {meta.genres.map((g) => (
                  <button key={g.slug} className={`genre-chip ${genre === g.slug ? 'active' : ''}`} onClick={() => { setSelectedGenres([g.slug]); switchGenre(g.slug); }}>
                    {t(g.label)}
                  </button>
                ))}
              </div>
            )}
            <div className="browse-advanced-meta">
              <span className="browse-source-note">{t("仅筛选当前页；状态未注明的剧集只在“全部”显示。")}</span>
              {source === 'hongguo' && catalogChannel === 'app' && <span className="browse-source-note">{t("App 快速线路只显示部分片单；需要更完整的目录时请切换到“官网”。")}</span>}
              {!mobile && source === 'hongguo' && catalogChannel === 'web' && sourceUrl && (
                <button type="button" className="btn btn-outline btn-sm" onClick={showBrowser}><ExternalLink size={13} />{t("打开来源页面")}</button>
              )}
            </div>
          </div>
        )}
      </FilterContainer>

      {sourcesError && <p className="browse-source-note" role="status">{t("来源列表更新失败，暂用上次列表。可在设置重新保存来源后重试。")}</p>}
      {source.startsWith('custom:') && <p className="browse-source-note">{t("来自 ")}{mediaSourceLabel(source, mediaSources)}{t(" 的接口目录，按来源顺序显示，不代表热播榜。")}</p>}
      {source === 'xifan' && <p className="browse-source-note">{t("当前提供题材分类，西饭热播榜暂未接入。")}</p>}
      {source === 'reelshort' && <p className="browse-source-note">{t("官网公开片单，按原顺序显示，每类最多 12 部；当前只提供首页快照，无后续分页。受地区限制，付费集请在官方平台确认权限。")}</p>}
      {refreshNotice && <p className="browse-source-note" role="status">{t(refreshNotice)}</p>}

      {/* 6. Content Toolbar */}
      <div className="browse-content-toolbar">
        <div className="browse-content-toolbar-left">
          <span className="browse-count-badge">
            {t("共 ")}{t(meta.total || visibleResults.length)}{t(" 部")}
          </span>
          <span className="browse-cat-indicator">{t(activeCategoryLabel)}</span>
          {genre && <span className="browse-cat-indicator is-genre">{t(meta.genres.find(g => g.slug === genre)?.label || genre)}</span>}
        </div>
        <div className="browse-content-toolbar-right">
          <select className="browse-sort-select" aria-label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="default">{t("默认分类")}</option>
            <option value="rank">{t("热播榜")}</option>
            <option value="episodes">{t("集数")}</option>
            <option value="title">{t("标题")}</option>
          </select>
          <div className="browse-view-toggle" role="group" aria-label="View mode">
            <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => changeViewMode('grid')} title="Grid view" aria-label="Grid view">
              <LayoutGrid size={15} />
            </button>
            <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => changeViewMode('list')} title="List view" aria-label="List view">
              <List size={15} />
            </button>
          </div>
          <button className="btn btn-outline btn-sm" disabled={loading || sourcesLoading || meta.cursorExpired || page !== displayedPage || !hasNextBatch} onClick={() => gotoPage(displayedPage + 1)}>
            <RefreshCw size={13} />{t("换一批")}
          </button>
        </div>
      </div>

      {!loading && !error && results.length > 0 && visibleResults.length === 0 && <div className="browse-filter-empty" role="status"><p>{t("本页没有明确标记为")}{t(completion === 'completed' ? '已完结' : '更新中')}{t("的剧集。")}</p><button className="btn btn-outline" onClick={() => setCompletion('all')}>{t("显示本页全部")}</button></div>}

      {error && results.length > 0 && <div className="alert alert-error browse-update-error" role="alert">
        <span>{t(error)}</span><button className="btn btn-outline btn-sm" disabled={loading || sourcesLoading} onClick={retryList}>{t("重试")}</button>
      </div>}
      {error && results.length === 0 && <div className="browse-error-state" role={unsupported ? 'status' : 'alert'}><Film size={36} /><h3>{t(unsupported ? '这里是图文漫画' : '暂时没能加载剧集')}</h3><p>{t(error)}</p><div className="search-empty-actions">{unsupported ? <button className="btn btn-primary" onClick={() => switchCategory('comic-drama')}>{t("查看漫剧")}</button> : <button className="btn btn-primary" onClick={retryList}><RefreshCw size={15} />{t("重新加载")}</button>}<button className="btn btn-outline" onClick={() => onNavigate('download')}>{t("按剧名搜索")}</button></div></div>}

      {loading && results.length > 0 && <div className="browse-loading" role="status"><RefreshCw size={16} className="spin" /><span>{t("正在更新片单，仍可浏览上次结果…")}</span><button className="btn btn-outline btn-sm" onClick={cancelList}>{t("取消加载")}</button></div>}

      {/* 7. Drama Poster Grid / List */}
      {loading && results.length === 0 ? (
        <div className="browse-loading-state" role="status">
          <div className="browse-loading"><RefreshCw size={16} className="spin" /><span>{t("正在加载")}{t(activeCategoryLabel)}…</span><button className="btn btn-outline btn-sm" onClick={cancelList}>{t("取消加载")}</button></div>
          <div className="poster-skeletons" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div className="poster-skeleton" key={i}><div /><span /><span /></div>)}</div>
        </div>
      ) : (
        <div className={viewMode === 'list' ? 'browse-list' : 'browse-grid'}>
          {visibleResults.map((item) => {
            const dl = downloadedMap[String(item.series_id)];
            const isFav = favorites.has(String(item.series_id));
            return (
              <article className="browse-card-item" key={item.series_id}>
                <div className="browse-card" onClick={() => openSeries(item)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSeries(item); } }}
                  title={item.series_title}
                >
                  <div className="browse-cover">
                    {item.rank > 0 && <span className="browse-rank-badge">#{item.rank}</span>}
                    {item.cover ? (
                      <img src={item.cover} alt={item.series_title} loading="lazy" />
                    ) : (
                      <div className="cover-placeholder"><Film size={22} /></div>
                    )}
                    {(item.episode_label || item.episode_count > 0) && (
                      <span className="browse-ep-badge">{t(item.episode_label || `${item.episode_count} 集`)}</span>
                    )}
                    {dl && dl.completed > 0 && (
                      <span className="browse-dl-badge">
                        <Check size={11} /> {t(dl.completed)}/{t(dl.total)}
                      </span>
                    )}
                    <div className="browse-hover">
                      <button type="button" className="browse-quick-btn is-primary" title={t("立即播放")} aria-label={t("立即播放")}
                        onClick={(e) => { e.stopPropagation(); openSeries(item, true); }}>
                        <Play size={14} />
                      </button>
                      <button type="button" className="browse-quick-btn" title={t("剧集详情")} aria-label={t("剧集详情")}
                        onClick={(e) => { e.stopPropagation(); openSeries(item, false); }}>
                        <Eye size={14} />
                      </button>
                      <button type="button" className="browse-quick-btn" title={t("选集下载")} aria-label={t("选集下载")}
                        onClick={(e) => { e.stopPropagation(); openSeries(item, false); }}>
                        <Download size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="browse-card-body">
                    <div className="browse-card-title">{item.series_title}</div>
                    <div className="browse-card-meta-row">
                      <div className="browse-card-meta-left">
                        {item.heat && <span className="browse-card-heat">{t(item.heat)}</span>}
                        {!item.heat && item.completion_status === 'completed' && <span className="browse-completion-label">{t("已完结")}</span>}
                        {!item.heat && item.completion_status === 'ongoing' && <span className="browse-completion-label">{t("更新中")}</span>}
                        {item.tags && item.tags.length > 0 && <span className="browse-tag">{t(item.tags[0])}</span>}
                      </div>
                      <button
                        type="button"
                        className={`browse-fav-btn ${isFav ? 'is-fav' : ''}`}
                        aria-pressed={isFav}
                        aria-label={t(isFav ? '取消收藏' : '收藏')}
                        title={t(isFav ? '取消收藏' : '收藏')}
                        onClick={(e) => toggleFavorite(item, e)}
                      >
                        <Heart size={14} />
                      </button>
                    </div>
                  </div>
                </div>
                {mobile && <button className="mobile-drama-details" aria-label={t(`详情与下载：${item.series_title}`)} onClick={() => openSeries(item, false)}>{t(openingId === item.series_id ? '正在打开…' : '详情与下载')}</button>}
              </article>
            );
          })}
        </div>
      )}

      {/* 8. Compact Centered Pagination */}
      {totalPages > 1 && (
        <div className="browse-pager">
          <button className="pager-item pager-nav" aria-label={t("上一页")} disabled={displayedPage <= 1 || meta.cursorExpired} onClick={() => gotoPage(displayedPage - 1)}>
            <ChevronLeft size={14} /><span>{t("上一页")}</span>
          </button>
          {pageNumbers.map((n, i) => (
            <React.Fragment key={n}>
              {i > 0 && n - pageNumbers[i - 1] > 1 && <span className="pager-gap">…</span>}
              <button
                className={`pager-item ${n === displayedPage ? 'active' : ''}`}
                disabled={meta.cursorExpired}
                onClick={() => gotoPage(n)}
              >
                {n}
              </button>
            </React.Fragment>
          ))}
          <button className="pager-item pager-nav" aria-label={t("下一页")} disabled={displayedPage >= totalPages || meta.cursorExpired} onClick={() => gotoPage(displayedPage + 1)}>
            <span>{t("下一页")}</span><ChevronRight size={14} />
          </button>
        </div>
      )}

      {!totalPages && (displayedPage > 1 || meta.hasMore) && (
        <div className="browse-pager">
          <button className="pager-item pager-nav" disabled={displayedPage <= 1 || loading || meta.cursorExpired} onClick={() => gotoPage(displayedPage - 1)}>
            <ChevronLeft size={14} /><span>{t("上一页")}</span>
          </button>
          <span className="pager-item active">{displayedPage}</span>
          <button className="pager-item pager-nav" disabled={!meta.hasMore || loading || meta.cursorExpired} onClick={() => gotoPage(displayedPage + 1)}>
            <span>{t("下一页")}</span><ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* ===== 剧集详情抽屉 ===== */}
      {(detail || detailLoading) && (
        <div className="browse-drawer-mask" onClick={closeDetail}>
          <div className="browse-drawer" role="dialog" aria-modal="true" aria-label={t("剧集详情")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="browse-drawer-head">
              <div className="browse-drawer-title">
                <Film size={18} />
                <span>{detail ? `《${detail.series_title}》` : t("加载中…")}</span>
              </div>
              <button className="icon-btn" onClick={closeDetail} title={t("关闭")}>
                <X size={16} />
              </button>
            </div>

            {detailLoading && (
              <div className="browse-loading">
                <RefreshCw size={18} className="spin" />
                <span>{t("正在拉取全集…")}</span>
              </div>
            )}

            {detail && (
              <>
                <div className="browse-drawer-body">
                  <div className="browse-drawer-info">
                    {detail.cover && <img src={detail.cover} alt="" className="browse-drawer-cover" />}
                    <div className="browse-drawer-meta">
                      <div className="browse-drawer-count">
                        {mediaSourceLabel(detail.series_id, mediaSources)}{t(" · 共 ")}{t(detail.total)}{t(" 集 · 已下载 ")}<b>{t(detail.completedCount)}</b>{t(" 集")}</div>
                      {detail.web_accessible_episodes != null && detail.web_accessible_episodes < detail.total && (
                        <div className="browse-drawer-sub">{t("网页源提供前 ")}{t(detail.web_accessible_episodes)}{t(" 集，后续集数自动尝试 App 片源。")}</div>
                      )}
                      {detail.episodes.some((ep) => ep.locked) && <div className="browse-drawer-sub">{t("标记“锁定”的集数需在来源平台解锁，本应用不提供解锁。")}</div>}
                      {(!mobile || selectingDownloads) && <>
                      <div className="browse-drawer-sub">{t("选中 ")}{t(selectedIdx.size)}{t(" 集待下载")}</div>
                      <div className="browse-range-row">
                        <input
                          type="text"
                          className="input-field"
                          aria-label={t("选择集数范围")}
                          placeholder={t("区间，如 1-50 或 1,3,5")}
                          value={rangeInput}
                          onChange={(e) => { setRangeInput(e.target.value); setRangeError(''); }}
                          onKeyDown={(e) => isSubmitKey(e) && applyRange(rangeInput)}
                        />
                        <button className="btn btn-outline btn-sm" onClick={() => applyRange(rangeInput)}>{t("应用")}</button>
                      </div>
                      {rangeError && <p className="alert alert-error" role="alert">{t(rangeError)}</p>}
                      <div className="preset-row mt8">
                        <button className="btn-chip" onClick={() => applyRange(`1-${Math.min(10, detail.total)}`)}>{t("前10集")}</button>
                        <button className="btn-chip" onClick={() => applyRange(`1-${Math.min(30, detail.total)}`)}>{t("前30集")}</button>
                        <button className="btn-chip" onClick={() => applyRange(`${Math.max(1, detail.total - 29)}-${detail.total}`)}>{t("后30集")}</button>
                        <button className="btn-chip" onClick={() => setSelectedIdx(new Set(detail.episodes.filter((e) => !e.locked).map((e) => e.vid_index)))}>{t("全选")}</button>
                        <button className="btn-chip" onClick={() => setSelectedIdx(new Set())}>{t("清空")}</button>
                      </div>
                      </>}
                    </div>
                  </div>

                  {mobile && detail.description && <details className="mobile-drama-description"><summary>{t("剧情简介")}</summary><p>{detail.description}</p></details>}
                  {mobile && <p className="browse-drawer-sub">{t(selectingDownloads ? '点选需要下载的集数' : '点选集数直接播放，已下载视频优先从本机播放')}</p>}

                  <div className="browse-eps">
                    {detail.episodes.map((ep) => (
                      <button
                        disabled={ep.locked === true}
                        aria-pressed={(!mobile || selectingDownloads) && selectedIdx.has(ep.vid_index)}
                        key={ep.vid_index}
                        className={`ep-chip ep-${ep.status} ${(!mobile || selectingDownloads) && selectedIdx.has(ep.vid_index) ? 'ep-picked' : ''}`}
                        onClick={() => mobile && !selectingDownloads ? playNow(ep.vid_index) : toggleIdx(ep.vid_index)}
                        title={(ep.locked ? t('需在来源平台解锁') : ep.title || t(`第 ${ep.vid_index} 集`))}
                      >
                        <span className="ep-num">{t(ep.vid_index)}</span>{ep.locked && <span className="ep-lock-label">{t("锁定")}</span>}
                        {ep.status === 'completed' && <Check size={11} className="ep-badge" />}
                        {(!mobile || selectingDownloads) && selectedIdx.has(ep.vid_index) && <span className="ep-pick-dot" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="browse-drawer-foot">
                  <button className={`btn ${mobile && !selectingDownloads ? 'btn-primary' : 'btn-outline'}`} disabled={!detail.episodes.some((ep) => !ep.locked)} onClick={mobile && selectingDownloads ? () => setSelectingDownloads(false) : playNow}>
                    <Play size={15} />
                    {t(mobile && selectingDownloads ? '返回播放' : '立即播放')}
                  </button>
                  <div className="browse-foot-right">
                    <button
                      className={`btn ${mobile && !selectingDownloads ? 'btn-outline' : 'btn-primary'}`}
                      disabled={submitting || (!mobile || selectingDownloads) && selectedIdx.size === 0}
                      onClick={mobile && !selectingDownloads ? () => { setSelectedIdx(new Set()); setSelectingDownloads(true); } : downloadSelected}
                    >
                      <Download size={15} />
                      {t(mobile && !selectingDownloads ? '选集下载' : `下载选中 (${selectedIdx.size})`)}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={`dm-toast dm-toast-${toast.type}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export default Browse;
