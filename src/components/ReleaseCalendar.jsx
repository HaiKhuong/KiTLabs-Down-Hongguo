import { t, useLanguage } from '../i18n';
import React, { useEffect, useMemo, useState } from 'react';
import { publicDateKey, readLocalLibrary, removeLocalSeries, saveLocalSeries, subscribeLocalLibrary } from '../localLibrary';
import { Bookmark, CheckCircle, Clock, Film, Heart, Info, LayoutGrid, List, Play, RefreshCw, Search, Trash2 } from './icons';
import './ReleaseCalendar.css';

export default function ReleaseCalendar({ onPlay, opening = '', active = true }) {
  useLanguage();
  const [library, setLibrary] = useState(readLocalLibrary);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'dated' | 'pending'
  const [chosenMonth, setChosenMonth] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('recent'); // 'recent' | 'title' | 'date'
  const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'list'
  const [showInfo, setShowInfo] = useState(false);
  const [catalogCovers, setCatalogCovers] = useState(() => new Map());

  useEffect(() => subscribeLocalLibrary(setLibrary), []);

  useEffect(() => {
    if (!library.items.some(item => !item.cover) || !window.electronAPI?.getSeriesList) return;
    let cancelled = false;
    window.electronAPI.getSeriesList().then(items => {
      if (!cancelled && Array.isArray(items)) {
        setCatalogCovers(new Map(items.map(item => [String(item.series_id), item.cover || ''])));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [library.items]);

  const rows = useMemo(
    () => library.items.map((item, idx) => ({
      ...item,
      _order: idx,
      cover: item.cover || catalogCovers.get(item.id) || '',
      date: publicDateKey(item.published_at),
    })),
    [library.items, catalogCovers]
  );

  const dated = useMemo(() => rows.filter(item => item.date).sort((a, b) => b.date.localeCompare(a.date)), [rows]);
  const favoritesCount = useMemo(() => rows.filter(item => item.favorite).length, [rows]);

  const scopedByTab = useMemo(
    () => rows.filter(item => !favoritesOnly || item.favorite),
    [rows, favoritesOnly]
  );

  const months = useMemo(
    () => [...new Set(scopedByTab.filter(item => item.date).map(item => item.date.slice(0, 7)))].sort().reverse(),
    [scopedByTab]
  );

  const activeMonth = chosenMonth && months.includes(chosenMonth) ? chosenMonth : '';

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = scopedByTab.filter((item) => {
      if (statusFilter === 'dated' && !item.date) return false;
      if (statusFilter === 'pending' && item.date) return false;
      if (activeMonth && (!item.date || !item.date.startsWith(`${activeMonth}-`))) return false;
      if (q && !(item.title || '').toLowerCase().includes(q)) return false;
      return true;
    });

    if (sortBy === 'title') {
      return [...list].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'));
    }
    if (sortBy === 'date') {
      return [...list].sort((a, b) => {
        if (a.date && b.date) return b.date.localeCompare(a.date) || (a.title || '').localeCompare(b.title || '', 'zh-CN');
        if (a.date) return -1;
        if (b.date) return 1;
        return b._order - a._order;
      });
    }
    return [...list].sort((a, b) => b._order - a._order);
  }, [scopedByTab, statusFilter, activeMonth, searchQuery, sortBy]);

  const hasFilters = statusFilter !== 'all' || !!activeMonth || searchQuery.trim() !== '';

  return (
    <section className="release-calendar">
      {/* 2. Page Header */}
      <header className="rc-header">
        <div className="rc-header-left">
          <div className="rc-header-icon"><Bookmark size={20} /></div>
          <div>
            <h2>{t("上新日历")}</h2>
            <p className="rc-subtitle">{t("已浏览剧集的首次公开日历。打开剧集的「公开剧评」后，真实日期会保存在这里。")}</p>
          </div>
        </div>
        <div className="rc-header-right">
          <div className="rc-summary-pills">
            <span className="rc-summary-pill">{t("本机收录 ")}{rows.length}</span>
            <span className="rc-summary-pill is-dated">{t("有公开日期 ")}{dated.length}</span>
          </div>
          <button
            type="button"
            className={`icon-btn rc-info-btn ${showInfo ? 'is-active' : ''}`}
            title={t("按北京时间显示，不是完整上新排期。")}
            aria-label={t("按北京时间显示，不是完整上新排期。")}
            aria-expanded={showInfo}
            onClick={() => setShowInfo(v => !v)}
          >
            <Info size={16} />
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setLibrary(readLocalLibrary())}>
            <RefreshCw size={14} /><span>{t("重新读取")}</span>
          </button>
        </div>
      </header>

      {showInfo && (
        <p className="rc-info-banner">
          {t("本机收录 ")}{rows.length}{t(" 部 · 有公开日期 ")}{dated.length}{t(" 部")}
          {dated.length > 0 ? ` · ${dated[dated.length - 1].date} 至 ${dated[0].date}` : ''}
          {t("。按北京时间显示，不是完整上新排期。")}
        </p>
      )}

      {library.error && (
        <div className="alert alert-error rc-error" role="alert">
          <p>{t(library.error)}</p>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setLibrary(readLocalLibrary())}>{t("重新读取")}</button>
        </div>
      )}

      {/* 3 & 5. Main Tabs + Library Toolbar */}
      <div className="rc-toolbar">
        <div className="rc-tabs" role="group" aria-label={t("日历范围")}>
          <button type="button" className={!favoritesOnly ? 'is-active' : ''} aria-pressed={!favoritesOnly} onClick={() => setFavoritesOnly(false)}>
            <span>{t("全部已浏览")}</span>
            <em className="rc-tab-count">{rows.length}</em>
          </button>
          <button type="button" className={favoritesOnly ? 'is-active' : ''} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(true)}>
            <span>{t("本机收藏 ")}</span>
            <em className="rc-tab-count">{favoritesCount}</em>
          </button>
        </div>

        <div className="rc-controls">
          <div className="rc-search-wrap">
            <Search size={14} />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("搜索剧名…")}
              aria-label={t("搜索剧名…")}
            />
          </div>

          <select className="rc-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t("全部状态")}>
            <option value="all">{t("全部状态")}</option>
            <option value="dated">{t("已公开日期")}</option>
            <option value="pending">{t("待公开")}</option>
          </select>

          {months.length > 0 && statusFilter !== 'pending' && (
            <select className="rc-select" value={activeMonth} onChange={(e) => setChosenMonth(e.target.value)} aria-label={t("月份")}>
              <option value="">{t("查看全部")}</option>
              {months.map(value => (
                <option key={value} value={value}>{value.slice(0, 4)} {t("年 ")} {Number(value.slice(5))} {t("月")}</option>
              ))}
            </select>
          )}

          <select className="rc-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label={t("最近添加")}>
            <option value="recent">{t("最近添加")}</option>
            <option value="title">{t("剧名 A–Z")}</option>
            <option value="date">{t("公开日期")}</option>
          </select>

          <div className="browse-view-toggle" role="group" aria-label="View mode">
            <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')} title="Grid view" aria-label="Grid view">
              <LayoutGrid size={14} />
            </button>
            <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')} title="List view" aria-label="List view">
              <List size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* 9. Empty States */}
      {!library.error && scopedByTab.length === 0 && (
        <div className="rc-empty">
          <Bookmark size={36} />
          <h3>{t(favoritesOnly ? '还没有本机收藏' : '还没有可展示的剧集')}</h3>
          <p>{t("前往「发现短剧」打开官方短剧，展开「公开剧评」读取首次公开日期；也可以点「收藏到本机」，留待下次观看。")}</p>
        </div>
      )}

      {!library.error && scopedByTab.length > 0 && filteredItems.length === 0 && (
        <div className="rc-empty">
          <Search size={34} />
          <h3>{t("没有找到相关短剧")}</h3>
          {hasFilters && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => { setStatusFilter('all'); setChosenMonth(''); setSearchQuery(''); }}>
              {t("清空筛选")}
            </button>
          )}
        </div>
      )}

      {/* 6 & 7. Drama Cards */}
      {filteredItems.length > 0 && (
        <div className={viewMode === 'grid' ? 'rc-cards-grid' : 'rc-cards-list'}>
          {filteredItems.map((item) => (
            <article key={item.id} className="rc-drama-card">
              <div className="rc-card-poster" aria-hidden="true">
                {item.cover
                  ? <img key={item.cover} src={item.cover} alt="" loading="lazy" onError={e => { e.currentTarget.style.display = 'none'; }} />
                  : <div className="cover-placeholder"><Film size={20} /></div>}
              </div>

              <div className="rc-card-body">
                <h3 className="rc-card-title" title={item.title}>{item.title}</h3>

                <div className="rc-card-meta">
                  {item.date ? (
                    <span className="rc-status-badge is-confirmed">
                      <CheckCircle size={12} />
                      <span>{t(`首次公开 ${item.date}`)}</span>
                    </span>
                  ) : (
                    <span className="rc-status-badge is-pending" title={t("这些剧集已保存在本机，但服务尚未返回首次公开日期。")}>
                      <Clock size={12} />
                      <span>{t("暂无首次公开时间")}</span>
                    </span>
                  )}
                </div>

                <div className="rc-card-tags">
                  <button
                    type="button"
                    className={`rc-fav-chip ${item.favorite ? 'is-fav' : ''}`}
                    aria-label={t(`${item.favorite ? '取消收藏' : '收藏'}《${item.title}》`)}
                    aria-pressed={item.favorite}
                    onClick={() => setLibrary(saveLocalSeries({ id: item.id, title: item.title, favorite: !item.favorite }))}
                  >
                    <Heart size={12} />
                    <span>{t(item.favorite ? '已收藏' : '收藏')}</span>
                  </button>
                </div>
              </div>

              <div className="rc-card-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!onPlay || !!opening || !active}
                  aria-label={t(`播放《${item.title}》`)}
                  onClick={() => onPlay?.({ seriesId: item.id, title: item.title })}
                >
                  <Play size={13} />
                  <span>{t(opening === item.id ? '打开中…' : '播放')}</span>
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-danger"
                  aria-label={t(`移除《${item.title}》`)}
                  title={t("仅移除本机收藏与日历记录，不删除视频文件")}
                  onClick={() => setLibrary(removeLocalSeries(item.id))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
