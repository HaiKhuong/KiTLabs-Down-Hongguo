import { t, useLanguage } from '../i18n';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useDanmakuSource, writeDanmakuSource } from './danmakuSource.mjs';
import useDialogKeyboard from './useDialogKeyboard';
import './Settings.css';
import AppearanceSettings from './AppearanceSettings';
import ShortcutSettings from './ShortcutSettings';
import StealthWakeRegion from './StealthWakeRegion.jsx';
import { FULL_WAKE_REGION, validWakeRegion } from './stealthWakeRegion.mjs';
import CustomSources from './CustomSources';
import BuiltinSources from './BuiltinSources';
import AnnouncementSettings from './AnnouncementSettings';
import {
  Settings, Folder, Check, Globe, X, RefreshCw, AlertCircle,
  SlidersHorizontal, Play, Download, Keyboard, Bell, PictureInPicture, Info, Search, Copy
} from './icons';

const CATEGORY_STORAGE_KEY = 'hg_settings_category';

const CATEGORIES = [
  { id: 'general', label: '通用', desc: '语言、外观、界面缩放与海报尺寸。', icon: SlidersHorizontal },
  { id: 'playback', label: '播放设置', desc: '缓存、兼容转码、弹幕评论与搜索偏好。', icon: Play },
  { id: 'downloads', label: '下载', desc: '保存目录、命名模板、默认清晰度与并发数。', icon: Download },
  { id: 'sources', label: '片源与代理', desc: '内置来源、自定义源与网络代理配置。', icon: Globe },
  { id: 'shortcuts', label: '快捷键', desc: '播放器快捷键、长按倍速与老板键。', icon: Keyboard },
  { id: 'notifications', label: '通知与公告', desc: '追剧更新提醒与官方公告接收偏好。', icon: Bell },
  { id: 'mini-window', label: '小窗与画中画', desc: '画中画模式与小窗唤醒区域设置。', icon: PictureInPicture },
  { id: 'about', label: '关于与更新', desc: '配置文件路径、版本信息与软件更新。', icon: Info },
];

const SEARCH_INDEX = [
  { label: '界面语言', category: 'general', keywords: 'language 语言 english vietnamese' },
  { label: '外观', category: 'general', keywords: 'appearance theme dark light system 主题' },
  { label: '界面与字号', category: 'general', keywords: 'zoom scale text size 缩放 100%' },
  { label: '海报大小', category: 'general', keywords: 'poster size cover 封面' },
  { label: '缓存后续 2 集', category: 'playback', keywords: 'cache preload next episodes 预缓存' },
  { label: '自动兼容模式', category: 'playback', keywords: 'compat transcode bytevc2 解码 转码' },
  { label: '看完自动删除', category: 'playback', keywords: 'delete watched 自动删除' },
  { label: '显示弹幕按钮', category: 'playback', keywords: 'comments danmaku controls 评论 弹幕' },
  { label: '弹幕来源', category: 'playback', keywords: 'comment source danmaku 评论来源' },
  { label: '优先使用红果 App 搜索', category: 'playback', keywords: 'search app preference 搜索' },
  { label: '下载目录', category: 'downloads', keywords: 'download folder path 目录 文件夹' },
  { label: '普通下载保存整剧资料', category: 'downloads', keywords: 'metadata nfo cover 剧集资料' },
  { label: '文件命名规则', category: 'downloads', keywords: 'filename pattern template 命名 模板' },
  { label: '默认下载清晰度', category: 'downloads', keywords: 'download quality 1080p 720p auto 清晰度' },
  { label: '最大并发下载数', category: 'downloads', keywords: 'concurrent downloads 并发' },
  { label: '内置来源', category: 'sources', keywords: 'builtin sources hongguo xifan hema reelshort dramabox' },
  { label: '自定义播放源', category: 'sources', keywords: 'custom source apple cms api 自定义源' },
  { label: '网络代理', category: 'sources', keywords: 'proxy network clash v2ray direct system 代理' },
  { label: '播放快捷键', category: 'shortcuts', keywords: 'shortcut keybindings fullscreen 2x 快捷键' },
  { label: '老板键', category: 'shortcuts', keywords: 'boss key global shortcut 老板键' },
  { label: '自动检查新集', category: 'notifications', keywords: 'watch updates episodes 新集提醒' },
  { label: '查找疑似新一季', category: 'notifications', keywords: 'sequels new season 新一季' },
  { label: '发送系统通知', category: 'notifications', keywords: 'system notifications 系统通知' },
  { label: '公告通知', category: 'notifications', keywords: 'announcements emergency normal 公告' },
  { label: '画中画小窗', category: 'mini-window', keywords: 'picture in picture pip native custom 画中画' },
  { label: '唤醒区域', category: 'mini-window', keywords: 'wake area stealth mini window 小窗 唤醒' },
  { label: '配置文件位置', category: 'about', keywords: 'config path data dir portable 配置路径' },
  { label: '自动检测更新', category: 'about', keywords: 'updates check version 更新 版本' },
];

const FORMAT_PRESETS = [
  { label: '剧名_第N集', value: '剧名 集数' },
  { label: '剧名_第N集_标题', value: '剧名 集数 标题' },
];

const PROXY_MODES = [
  { value: 'system', label: '跟随系统', desc: '接口与下载读取启动环境代理；发现页等浏览器请求使用系统代理' },
  { value: 'custom', label: '手动指定', desc: '填写 HTTP/HTTPS 代理地址与端口，忽略环境变量中的绕过规则（NO_PROXY）' },
  { value: 'direct', label: '强制直连', desc: '忽略一切代理，直接连接' },
];

const PORT_PRESETS = [
  { label: 'Clash / Mihomo', port: 7890 },
  { label: 'V2rayN', port: 10809 },
  { label: 'Shadowsocks', port: 1080 },
  { label: 'Burp / 抓包', port: 8080 },
];

function describeProxy(settings) {
  if (!settings || settings.proxy_enabled !== true) {
    return { on: false, text: '未启用（所有请求直连）' };
  }
  const mode = settings.proxy_mode || 'system';
  if (mode === 'direct') {
    return { on: false, text: '已开启但模式为「强制直连」' };
  }
  if (mode === 'custom') {
    const host = (settings.proxy_host || '').trim();
    const port = (settings.proxy_port || '').toString().trim();
    if (!host) return { on: false, text: '已开启，但未填写代理地址' };
    return { on: true, text: `${host}${port ? ':' + port : ''}` };
  }
  return { on: true, text: '接口/下载跟随启动环境，浏览器跟随系统' };
}

function previewFilename(pattern) {
  const raw = (pattern || '剧名 集数').trim() || '剧名 集数';
  return raw
    .replace(/剧名/g, '示例短剧')
    .replace(/集数/g, '001')
    .replace(/标题/g, '初遇')
    .replace(/\s+/g, '_') + '.mp4';
}

function readSavedCategory() {
  try {
    const saved = localStorage.getItem(CATEGORY_STORAGE_KEY);
    if (saved && CATEGORIES.some(c => c.id === saved)) return saved;
  } catch (_) {}
  return 'general';
}

function SettingsPage({ active = true, preview = false, appInfo = null, wakeRegionFocus = 0 }) {
  useLanguage();
  const danmakuSource = useDanmakuSource();
  const [category, setCategory] = useState(readSavedCategory);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState(null);
  const [wakeModalOpen, setWakeModalOpen] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pictureModeSaving, setPictureModeSaving] = useState(false);
  const [pictureModeNotice, setPictureModeNotice] = useState('');
  const [pictureModeError, setPictureModeError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState('');
  const testVersion = useRef(0);
  const savingRef = useRef(false);
  const pictureModeRequest = useRef({ pending: false, version: 0 });
  const editedKeys = useRef(new Set());
  const savedTimer = useRef(null);
  const searchWrapRef = useRef(null);

  const selectCategory = (id) => {
    setCategory(id);
    try { localStorage.setItem(CATEGORY_STORAGE_KEY, id); } catch (_) {}
  };

  useEffect(() => {
    if (wakeRegionFocus > 0) {
      selectCategory('mini-window');
      setWakeModalOpen(true);
    }
  }, [wakeRegionFocus]);

  useEffect(() => {
    const onDocDown = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  const loadSettings = async () => {
    setLoadError('');
    try { setSettings({ download_quality: 'auto', picture_in_picture_mode: 'custom', ...await window.electronAPI.getSettings() }); }
    catch (error) { setLoadError(error.message || '设置加载失败，请重试'); }
  };

  const refreshSettings = async () => {
    if (savingRef.current) return;
    const modeVersion = pictureModeRequest.current.version;
    try {
      const fresh = { download_quality: 'auto', picture_in_picture_mode: 'custom', ...await window.electronAPI.getSettings() };
      setSettings(prev => {
        if (!prev) return fresh;
        const merged = { ...fresh };
        for (const key of editedKeys.current) {
          if (Object.hasOwn(prev, key)) merged[key] = prev[key];
        }
        if (pictureModeRequest.current.pending || modeVersion !== pictureModeRequest.current.version) {
          merged.picture_in_picture_mode = prev.picture_in_picture_mode;
        }
        return merged;
      });
      setLoadError('');
    } catch (error) {
      setLoadError(error.message || '设置加载失败，请重试');
    }
  };

  useEffect(() => () => { testVersion.current++; clearTimeout(savedTimer.current); }, []);

  useEffect(() => {
    if (!active) {
      testVersion.current++;
      setTesting(false);
      setTestResult(null);
      return;
    }
    void refreshSettings();
  }, [active]);

  const update = (key, value) => {
    editedKeys.current.add(key);
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setDirty(true);
    setSaveError('');
  };

  const changePictureInPictureMode = async (event) => {
    const mode = event.target.value;
    const request = pictureModeRequest.current;
    if (!['native', 'custom'].includes(mode) || request.pending) return;
    request.pending = true;
    request.version++;
    const previous = settings.picture_in_picture_mode === 'native' ? 'native' : 'custom';
    setSettings(prev => ({ ...prev, picture_in_picture_mode: mode }));
    setPictureModeSaving(true);
    setPictureModeNotice('');
    setPictureModeError('');
    try {
      const result = await window.electronAPI.saveSettings({ picture_in_picture_mode: mode });
      if (!result?.success) throw new Error(result?.error || '画中画小窗设置保存失败，请重试');
      setPictureModeNotice('已自动保存，下次开启悬浮窗时生效');
    } catch (error) {
      setSettings(prev => ({ ...prev, picture_in_picture_mode: previous }));
      setPictureModeError(error.message || '画中画小窗设置保存失败，请重试');
    } finally {
      request.pending = false;
      request.version++;
      setPictureModeSaving(false);
    }
  };

  const selectFolder = async () => {
    try {
      const dir = await window.electronAPI.selectFolder();
      if (dir) update('root', dir);
    } catch (error) { setSaveError(error.message || '文件夹选择失败，请重试'); }
  };

  const persist = async (next, isProxy = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError('');
    try {
      const editable = ['root', 'name_format', 'download_quality', 'download_metadata', 'cache_next_episode', 'compat_mode', 'auto_delete_watched', 'show_danmaku_controls', 'max_concurrent', 'proxy_enabled', 'proxy_mode', 'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password', 'watch_updates_enabled', 'watch_sequels_enabled', 'watch_notifications_enabled', 'search_app_enabled', 'app_updates_enabled'];
      const submitted = {};
      for (const key of editable) {
        if (Object.hasOwn(next, key) && (editedKeys.current.has(key) || isProxy && key.startsWith('proxy_'))) submitted[key] = next[key];
      }
      if (isProxy) submitted.clear_proxy_password = next.clear_proxy_password === true && !String(next.proxy_password || '');
      const res = await window.electronAPI.saveSettings(submitted);
      if (!res?.success) throw new Error(res?.error || '设置未保存，请重试');
      if (isProxy) closeProxy();
      const freshSaved = await window.electronAPI.getSettings();
      setSettings(freshSaved);
      window.dispatchEvent(new CustomEvent('hongguo-playback-settings', { detail: freshSaved }));
      editedKeys.current.clear();
      setDirty(false);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setSaveError(error.message || '设置保存失败，请重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const save = () => persist(settings);

  const closeProxy = () => {
    testVersion.current++;
    setTesting(false);
    setProxyOpen(false);
    setProxyDraft(null);
    setTestResult(null);
  };

  const openProxyModal = () => {
    testVersion.current++;
    setProxyDraft({
      proxy_enabled: settings.proxy_enabled === true,
      proxy_mode: settings.proxy_mode || 'system',
      proxy_host: settings.proxy_host || '127.0.0.1',
      proxy_port: settings.proxy_port || 7890,
      proxy_username: settings.proxy_username || '',
      proxy_password: '',
      clear_proxy_password: false,
    });
    setTestResult(null);
    setSaveError('');
    setProxyOpen(true);
  };

  const patchDraft = (key, value) => {
    testVersion.current++;
    setProxyDraft((prev) => ({ ...prev, [key]: value }));
    setTesting(false);
    setTestResult(null);
  };

  const runTest = async () => {
    const request = ++testVersion.current;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.electronAPI.testProxy(proxyDraft);
      if (request === testVersion.current) setTestResult(res);
    } catch (e) {
      if (request === testVersion.current) setTestResult({ success: false, error: e.message });
    } finally {
      if (request === testVersion.current) setTesting(false);
    }
  };

  const applyProxy = () => persist({ ...settings, ...proxyDraft }, true);

  useDialogKeyboard(active && proxyOpen, () => { if (!savingRef.current) closeProxy(); }, '.proxy-modal');
  useDialogKeyboard(active && wakeModalOpen, () => { setWakeModalOpen(false); void refreshSettings(); }, '.wake-area-modal');

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return SEARCH_INDEX.filter(item =>
      t(item.label).toLowerCase().includes(q) ||
      item.label.toLowerCase().includes(q) ||
      item.keywords.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [searchQuery]);

  if (!settings) {
    return (
      <div className="settings-container">
        {loadError
          ? <div role="alert" className="alert alert-error"><p>{t(loadError)}</p><button className="btn btn-outline btn-sm" onClick={loadSettings}>{t("重新加载")}</button></div>
          : <p className="settings-hint">{t('加载中...')}</p>}
      </div>
    );
  }

  const proxyInfo = describeProxy(settings);
  const mode = proxyDraft ? proxyDraft.proxy_mode : 'system';
  const activeCat = CATEGORIES.find(c => c.id === category) || CATEGORIES[0];
  const wakeRegion = validWakeRegion(settings.stealth_wake_region) ? settings.stealth_wake_region : FULL_WAKE_REGION;
  const isFullWake = Math.abs(wakeRegion.x) < 1e-6 && Math.abs(wakeRegion.y) < 1e-6 && Math.abs(wakeRegion.width - 1) < 1e-6 && Math.abs(wakeRegion.height - 1) < 1e-6;
  const wakeSummary = isFullWake
    ? t('唤醒区域：全窗')
    : `${t('唤醒区域')}：${Math.round(wakeRegion.x * 100)}%, ${Math.round(wakeRegion.y * 100)}% · ${Math.round(wakeRegion.width * 100)}% × ${Math.round(wakeRegion.height * 100)}%`;

  const copyConfigPath = async () => {
    const pathText = appInfo?.dataDir || '';
    if (!pathText) return;
    try {
      await navigator.clipboard?.writeText(pathText);
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 1800);
    } catch (_) {}
  };

  return (
    <div className="settings-container">
      <div className="settings-shell">
        {/* Left Sticky Category Navigation */}
        <nav className="settings-nav" aria-label={t("设置分类")}>
          <div className="settings-nav-title">
            <Settings size={17} />
            <span>{t("设置")}</span>
          </div>
          <div className="settings-nav-list">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const isCurrent = category === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  className={`settings-nav-item ${isCurrent ? 'is-active' : ''}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={() => selectCategory(cat.id)}
                >
                  <Icon size={15} />
                  <span>{t(cat.label)}</span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* Right Content Area */}
        <div className="settings-content-col">
          {/* 11. Sticky Settings Header */}
          <header className="settings-sticky-header">
            <div className="settings-header-left">
              <h2>{t(activeCat.label)}</h2>
              <p className="settings-header-desc">{t(activeCat.desc)}</p>
            </div>
            <div className="settings-header-right">
              <div className="settings-search-wrap" ref={searchWrapRef}>
                <Search size={14} />
                <input
                  type="search"
                  value={searchQuery}
                  onFocus={() => setSearchOpen(true)}
                  onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true); }}
                  placeholder={t("搜索设置…")}
                  aria-label={t("搜索设置…")}
                />
                {searchOpen && searchResults.length > 0 && (
                  <div className="settings-search-dropdown" role="listbox">
                    {searchResults.map((item) => {
                      const cat = CATEGORIES.find(c => c.id === item.category);
                      return (
                        <button
                          key={`${item.category}-${item.label}`}
                          type="button"
                          className="settings-search-item"
                          onClick={() => {
                            selectCategory(item.category);
                            setSearchQuery('');
                            setSearchOpen(false);
                          }}
                        >
                          <span>{t(item.label)}</span>
                          <em>{t(cat?.label || '')}</em>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <button
                type="button"
                className="btn btn-primary btn-sm settings-save-btn"
                disabled={saving || !dirty}
                onClick={save}
              >
                {saving ? t('正在保存…') : saved ? <><Check size={14} /><span>{t("已保存")}</span></> : t('保存设置')}
              </button>
            </div>
          </header>

          {saveError && !proxyOpen && <p className="alert alert-error" role="alert">{t(saveError)}</p>}
          {dirty && <p className="settings-dirty-banner" role="status">{t("有未保存的修改，点击右上角「保存设置」生效。")}</p>}

          {/* Active Category Panel */}
          <div className="settings-panel">
            {/* 3. General */}
            {category === 'general' && (
              <section className="settings-section" aria-label={t("外观设置")}>
                <AppearanceSettings active={active} />
              </section>
            )}

            {/* 4. Playback */}
            {category === 'playback' && (
              <fieldset className="settings-fieldset" disabled={saving}>
                <section className="settings-card">
                  <h3 className="settings-section-title">{t("播放与缓存")}</h3>
                  <div className="settings-switch-list">
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("缓存后续 2 集")}</span>
                        <em>{t("开始播放后最多预取接下来两集可在线播放的分集，减少连续切集等待；会使用网络流量。")}</em>
                      </div>
                      <input type="checkbox" role="switch" checked={settings.cache_next_episode !== false} onChange={e => update('cache_next_episode', e.target.checked)} />
                    </label>
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("自动兼容模式")}</span>
                        <em>{t("无法解码时尝试转码播放，解决部分黑屏有声问题。")}</em>
                      </div>
                      <input type="checkbox" role="switch" checked={settings.compat_mode !== false} onChange={e => update('compat_mode', e.target.checked)} />
                    </label>
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("看完自动删除")}</span>
                        <em>{t("看完一集后删除该集已下载的视频、在线播放缓存和转码缓存。下载文件会永久删除；保存后生效。")}</em>
                      </div>
                      <input type="checkbox" role="switch" checked={settings.auto_delete_watched === true} onChange={e => update('auto_delete_watched', e.target.checked)} />
                    </label>
                  </div>
                </section>

                <section className="settings-card">
                  <h3 className="settings-section-title">{t("弹幕按钮设置")}</h3>
                  <div className="settings-switch-list">
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("显示弹幕按钮")}</span>
                        <em>{t("保存后生效。关闭时隐藏弹幕及弹幕设置按钮，并停用弹幕；再次开启会恢复原有弹幕偏好。")}</em>
                      </div>
                      <input type="checkbox" role="switch" aria-label={t("显示弹幕按钮")} checked={settings.show_danmaku_controls !== false} onChange={e => update('show_danmaku_controls', e.target.checked)} />
                    </label>
                  </div>
                  <div className="settings-grid-2 settings-sub-row">
                    <div className="settings-group">
                      <label className="settings-label" htmlFor="danmaku-source">{t("弹幕来源")}</label>
                      <select id="danmaku-source" className="input-field select-field" value={danmakuSource} onChange={event => writeDanmakuSource(event.target.value)}>
                        <option value="official">{t("时间轴弹幕")}</option>
                        <option value="comments">{t("本集评论（备用）")}</option>
                      </select>
                      <p className="settings-hint">{t("切换立即生效，仅请求所选来源。")}</p>
                    </div>
                    <div className="settings-group settings-align-end">
                      <button type="button" className="btn btn-outline btn-sm" onClick={async () => {
                        try {
                          const result = await window.electronAPI.openExternalUrl('https://github.com/dawei233/hongguo-drama');
                          if (result?.success === false) throw new Error(result.error || '来源链接打开失败');
                        } catch (error) { setSaveError(error.message || '来源链接打开失败'); }
                      }}>{t("弹幕实现参考 dawei233/hongguo-drama（GPL-3.0）")}</button>
                    </div>
                  </div>
                </section>

                <section className="settings-card">
                  <h3 className="settings-section-title">{t("搜索偏好")}</h3>
                  <div className="settings-switch-list">
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("优先使用红果 App 搜索")}</span>
                        <em>{t("失败或空结果自动回退官网；关闭此项时，官网不可用仍会尝试 App 备用搜索。")}</em>
                      </div>
                      <input type="checkbox" role="switch" aria-label={t("优先使用红果 App 搜索")} checked={settings.search_app_enabled === true} onChange={e => update('search_app_enabled', e.target.checked)} />
                    </label>
                  </div>
                </section>
              </fieldset>
            )}

            {/* 5. Downloads */}
            {category === 'downloads' && (
              <fieldset className="settings-fieldset" disabled={saving}>
                <section className="settings-card">
                  <h3 className="settings-section-title">{t("存储位置与剧集资料")}</h3>
                  <div className="settings-group">
                    <label className="settings-label">{t("下载目录")}</label>
                    <div className="folder-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label={t("下载目录")}
                        value={settings.root || ''}
                        onChange={(e) => update('root', e.target.value)}
                        placeholder={t("选择下载保存目录")}
                      />
                      <button type="button" className="btn btn-outline" onClick={selectFolder}>
                        <Folder size={15} /><span>{t("选择文件夹")}</span>
                      </button>
                    </div>
                    <p className="settings-hint">{t("文件将保存到 ")}<code>{t("下载目录/红果短剧/剧名/")}</code>{t(" 下")}</p>
                  </div>

                  <div className="settings-switch-list">
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("普通下载保存整剧资料")}</span>
                        <em>{t("自动随视频保存封面、简介和 tvshow.nfo，不生成分集 NFO。可将下载目录设为已挂载的 NAS。")}</em>
                      </div>
                      <input type="checkbox" role="switch" aria-label={t("普通下载保存整剧资料")} checked={settings.download_metadata === true} onChange={e => update('download_metadata', e.target.checked)} />
                    </label>
                  </div>
                </section>

                <section className="settings-card">
                  <h3 className="settings-section-title">{t("画质、并发与命名")}</h3>
                  <div className="settings-grid-2">
                    <div className="settings-group">
                      <label className="settings-label" htmlFor="default-download-quality">{t("默认下载清晰度")}</label>
                      <select id="default-download-quality" className="input-field select-field"
                        value={settings.download_quality || 'auto'} aria-describedby="default-download-quality-hint"
                        onChange={(event) => update('download_quality', event.target.value)}>
                        <option value="auto">{t("自动（兼容优先）")}</option>
                        <option value="1080p">1080P</option>
                        <option value="720p">720P</option>
                      </select>
                      <p className="settings-hint" id="default-download-quality-hint">{t("所选清晰度不可用时自动尝试更低清晰度；已有文件不覆盖。")}</p>
                    </div>

                    <div className="settings-group">
                      <label className="settings-label">{t("最大并发下载数")}</label>
                      <select
                        className="input-field select-field"
                        aria-label={t("最大并发下载数")}
                        value={settings.max_concurrent || 3}
                        onChange={(e) => update('max_concurrent', parseInt(e.target.value, 10))}
                      >
                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                          <option key={n} value={n}>{t(n)}{t(" 个同时下载")}</option>
                        ))}
                      </select>
                      <p className="settings-hint">{t("同时下载 ")}<b>{settings.max_concurrent || 3}</b>{t(" 集（保存后立即生效）。建议 3~5。")}</p>
                    </div>
                  </div>

                  <div className="settings-group settings-sub-row">
                    <label className="settings-label">{t("文件命名规则")}</label>
                    <div className="preset-row">
                      {FORMAT_PRESETS.map((p) => (
                        <button
                          key={p.value}
                          type="button"
                          className={`btn-chip ${settings.name_format === p.value ? 'btn-chip-primary' : ''}`}
                          onClick={() => update('name_format', p.value)}
                        >
                          {t(p.label)}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      className="input-field"
                      aria-label={t("文件命名规则")}
                      value={settings.name_format || ''}
                      onChange={(e) => update('name_format', e.target.value)}
                    />
                    <p className="settings-hint">
                      {t("可用变量：")}<code>{t("剧名")}</code> · <code>{t("集数")}</code> · <code>{t("标题")}</code>
                      {' · '}<span>{t("预览")}：<code>{previewFilename(settings.name_format)}</code></span>
                    </p>
                  </div>
                </section>
              </fieldset>
            )}

            {/* 6. Sources & Proxy */}
            {category === 'sources' && (
              <div className="settings-fieldset">
                <BuiltinSources />
                <CustomSources active={active} />
                <fieldset className="settings-card" disabled={saving} aria-label={t("网络代理")}>
                  <div className="settings-group">
                    <div className="custom-sources-head-row">
                      <div>
                        <h3 className="settings-section-title">{t("网络代理")}</h3>
                        <p className="settings-hint">{t("手动代理用于接口、下载和应用内浏览器；跟随系统时读取启动环境代理。保存后立即生效。")}</p>
                      </div>
                      <button type="button" className="btn btn-outline btn-sm" onClick={openProxyModal}>
                        <Globe size={14} /><span>{t("配置代理")}</span>
                      </button>
                    </div>
                    <div className="proxy-status-row">
                      <span className={`proxy-dot ${proxyInfo.on ? 'proxy-dot-on' : 'proxy-dot-off'}`} />
                      <span className="proxy-status-text">
                        {t(proxyInfo.on ? <>{t("已启用：")}<code>{proxyInfo.text}</code></> : proxyInfo.text)}
                      </span>
                    </div>
                  </div>
                </fieldset>
              </div>
            )}

            {/* 7. Shortcuts */}
            {category === 'shortcuts' && (
              <div className="settings-fieldset">
                <ShortcutSettings active={active} />
              </div>
            )}

            {/* 8. Notifications */}
            {category === 'notifications' && (
              <fieldset className="settings-fieldset" disabled={saving}>
                <section className="settings-card">
                  <h3 className="settings-section-title">{t("追剧提醒")}</h3>
                  <div className="settings-switch-list">
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("自动检查新集")}</span>
                        <em>{t("应用运行期间，每部剧约 6 小时检查一次；列表较多时分批检查")}</em>
                      </div>
                      <input type="checkbox" role="switch" checked={settings.watch_updates_enabled !== false} onChange={e => update('watch_updates_enabled', e.target.checked)} />
                    </label>
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("查找疑似新一季")}</span>
                        <em>{t("约每天按剧名搜索一次，仅提示同名且季数更高的剧；可能遗漏或误报")}</em>
                      </div>
                      <input type="checkbox" role="switch" checked={settings.watch_sequels_enabled !== false} onChange={e => update('watch_sequels_enabled', e.target.checked)} />
                    </label>
                    <label className="settings-switch-row">
                      <div className="settings-switch-info">
                        <span>{t("发送系统通知")}</span>
                        <em>{t("默认关闭。开启后需允许系统通知；关闭不影响观看记录红点")}</em>
                      </div>
                      <input type="checkbox" role="switch" checked={settings.watch_notifications_enabled === true} onChange={e => update('watch_notifications_enabled', e.target.checked)} />
                    </label>
                  </div>
                </section>

                {!preview && (
                  <section className="settings-card">
                    <AnnouncementSettings />
                  </section>
                )}
              </fieldset>
            )}

            {/* 9. Mini Window */}
            {category === 'mini-window' && (
              <div className="settings-fieldset">
                <section className="settings-card" aria-label={t("画中画小窗设置")}>
                  <h3 className="settings-section-title">{t("画中画小窗")}</h3>
                  <div className="settings-group">
                    <label className="settings-label" htmlFor="picture-in-picture-mode">{t("画中画模式")}</label>
                    <select id="picture-in-picture-mode" className="input-field select-field"
                      value={settings.picture_in_picture_mode === 'native' ? 'native' : 'custom'}
                      disabled={!active || saving || pictureModeSaving}
                      aria-describedby="picture-in-picture-mode-hint"
                      onChange={changePictureInPictureMode}>
                      <option value="native">{t("系统原生")}</option>
                      <option value="custom">{t("应用自带")}</option>
                    </select>
                    <p className="settings-hint" id="picture-in-picture-mode-hint">{t("选择立即自动保存。系统原生使用操作系统画中画；应用自带可显示当前剧名并支持返回主窗口。")}</p>
                    {(pictureModeSaving || pictureModeNotice) && <p className="settings-hint" role="status">{t(pictureModeSaving ? '正在保存…' : pictureModeNotice)}</p>}
                    {pictureModeError && <p className="appearance-error" role="alert">{t(pictureModeError)}</p>}
                  </div>
                </section>

                {window.electronAPI.platform !== 'android' && (
                  <section className="settings-card" aria-label={t('小窗模式')}>
                    <div className="custom-sources-head-row">
                      <div>
                        <h3 className="settings-section-title">{t("小窗模式：隐藏后唤醒区域")}</h3>
                        <p className="settings-hint">{wakeSummary}</p>
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setWakeModalOpen(true)}>
                        {t("配置唤醒区域")}
                      </button>
                    </div>
                    <p className="settings-hint">{t("播放页顶部可开启小窗模式：窗口缩小、置顶；鼠标移开时暂停隐藏，移回指定唤醒区域继续。")}</p>
                  </section>
                )}
              </div>
            )}

            {/* 10. About & Updates */}
            {category === 'about' && (
              <fieldset className="settings-fieldset" disabled={saving}>
                <section className="settings-card">
                  <h3 className="settings-section-title">{t("配置文件位置")}</h3>
                  {settings.proxy_password_warning && <p className="alert alert-error" role="alert">{t(settings.proxy_password_warning)}</p>}
                  <div className="folder-row">
                    <input type="text" readOnly className="input-field settings-mono-input" value={appInfo?.dataDir || t('系统配置目录')} aria-label={t("配置文件位置")} />
                    {appInfo?.dataDir && (
                      <button type="button" className="btn btn-outline btn-sm" onClick={copyConfigPath}>
                        {pathCopied ? <><Check size={14} /><span>{t("已复制")}</span></> : <><Copy size={14} /><span>{t("复制路径")}</span></>}
                      </button>
                    )}
                  </div>
                  <p className="settings-hint">{t("代理密码由本机系统安全存储加密；更换电脑后可能需要重新输入。")}</p>
                  {appInfo?.configNote
                    ? <p className="settings-hint" role="status">{t(appInfo.configNote)}</p>
                    : <p className="settings-hint">{t(appInfo?.configMode === 'portable'
                      ? '便携版：设置、下载记录与界面数据保存在程序目录的 data 文件夹。'
                      : '设置、下载记录与界面数据保存在系统用户目录；更换电脑时可复制这个文件夹。')}</p>}
                </section>

                {preview ? (
                  <section className="settings-card">
                    <h3 className="settings-section-title">{t("独立预览")}</h3>
                    <p className="settings-hint">{t("预览数据独立保存，不接收正式版更新，不会覆盖已安装的红果短剧。")}</p>
                  </section>
                ) : (
                  <section className="settings-card">
                    <div className="custom-sources-head-row">
                      <div>
                        <h3 className="settings-section-title">{t("检测更新与版本")}</h3>
                        <p className="settings-hint">{appInfo?.version ? `${t("当前版本")}：v${appInfo.version}` : t('红果短剧桌面版')}</p>
                      </div>
                      <button type="button" className="btn btn-outline btn-sm" disabled={settings.app_updates_enabled === false} onClick={() => window.dispatchEvent(new CustomEvent('hongguo-check-app-update'))}>
                        <RefreshCw size={14} /><span>{t("检查更新")}</span>
                      </button>
                    </div>
                    <div className="settings-switch-list">
                      <label className="settings-switch-row">
                        <div className="settings-switch-info">
                          <span>{t("自动检测更新")}</span>
                          <em>{t("启动时及运行期间每 6 小时检查正式新版。保存后生效；下载和重启安装都由你点击确认。")}</em>
                        </div>
                        <input type="checkbox" role="switch" aria-label={t("自动检测更新")} checked={settings.app_updates_enabled !== false} onChange={e => update('app_updates_enabled', e.target.checked)} />
                      </label>
                    </div>
                  </section>
                )}
              </fieldset>
            )}
          </div>
        </div>
      </div>

      {/* Wake Area Modal */}
      {wakeModalOpen && window.electronAPI.platform !== 'android' && (
        <div className="proxy-modal-mask" onClick={() => { setWakeModalOpen(false); void refreshSettings(); }}>
          <div className="proxy-modal wake-area-modal" role="dialog" aria-modal="true" aria-label={t("小窗唤醒区域")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="proxy-modal-head">
              <div className="proxy-modal-title">
                <PictureInPicture size={18} />
                <span>{t("配置唤醒区域")}</span>
              </div>
              <button type="button" className="icon-btn" title={t("关闭")} onClick={() => { setWakeModalOpen(false); void refreshSettings(); }}>
                <X size={16} />
              </button>
            </div>
            <div className="proxy-modal-body">
              <StealthWakeRegion active={active && wakeModalOpen} focusRequest={wakeRegionFocus} />
            </div>
          </div>
        </div>
      )}

      {/* Network Proxy Modal */}
      {proxyOpen && proxyDraft && (
        <div className="proxy-modal-mask" onClick={() => !saving && closeProxy()}>
          <div className="proxy-modal" role="dialog" aria-modal="true" aria-label={t("网络代理设置")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="proxy-modal-head">
              <div className="proxy-modal-title">
                <Globe size={18} />
                <span>{t("网络代理设置")}</span>
              </div>
              <button className="icon-btn" title={t("关闭")} disabled={saving} onClick={closeProxy}>
                <X size={16} />
              </button>
            </div>

            <fieldset className="proxy-modal-body" disabled={saving}>
              <label className="proxy-switch-row">
                <input
                  type="checkbox"
                  checked={proxyDraft.proxy_enabled}
                  onChange={(e) => patchDraft('proxy_enabled', e.target.checked)}
                />
                <span className="proxy-switch-text">{t("启用代理")}<em>{t("关闭时代理不生效，所有请求直连")}</em>
                </span>
              </label>

              <div className={`proxy-fields ${proxyDraft.proxy_enabled ? '' : 'proxy-fields-disabled'}`}>
                <div className="settings-group">
                  <label className="settings-label">{t("代理模式")}</label>
                  <div className="proxy-mode-list">
                    {PROXY_MODES.map((m) => (
                      <label
                        key={m.value}
                        className={`proxy-mode-item ${mode === m.value ? 'active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="proxy_mode"
                          value={m.value}
                          checked={mode === m.value}
                          disabled={!proxyDraft.proxy_enabled}
                          onChange={() => patchDraft('proxy_mode', m.value)}
                        />
                        <span className="proxy-mode-body">
                          <b>{t(m.label)}</b>
                          <em>{t(m.desc)}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">{t("代理地址")}</label>
                    <div className="proxy-host-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label={t("代理服务器地址")}
                        placeholder="127.0.0.1"
                        value={proxyDraft.proxy_host}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_host', e.target.value)}
                      />
                      <span className="proxy-colon">:</span>
                      <input
                        type="number"
                        className="input-field proxy-port"
                        aria-label={t("代理端口")}
                        placeholder="7890"
                        min="1"
                        max="65535"
                        value={proxyDraft.proxy_port}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_port', e.target.value)}
                      />
                    </div>
                    <div className="preset-row mt8">
                      {PORT_PRESETS.map((p) => (
                        <button
                          key={p.port}
                          type="button"
                          className="btn-chip"
                          disabled={!proxyDraft.proxy_enabled}
                          onClick={() => patchDraft('proxy_port', p.port)}
                        >
                          {t(p.label)} {t(p.port)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">{t("代理认证（可选）")}</label>
                    <div className="proxy-auth-row">
                      <input
                        type="text"
                        className="input-field"
                        aria-label={t("代理用户名")}
                        placeholder={t("用户名")}
                        autoComplete="off"
                        value={proxyDraft.proxy_username}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_username', e.target.value)}
                      />
                      <input
                        type="password"
                        className="input-field"
                        aria-label={t("代理密码")}
                        placeholder={t(settings.proxy_password_set ? '已保存，留空表示不修改' : '密码')}
                        autoComplete="new-password"
                        value={proxyDraft.proxy_password}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => {
                          patchDraft('proxy_password', e.target.value);
                          if (e.target.value) patchDraft('clear_proxy_password', false);
                        }}
                      />
                    </div>
                    <p className="settings-hint">{t(proxyDraft.clear_proxy_password ? '保存后将清除已保存的密码。' : settings.proxy_password_set ? '已保存密码。输入新密码可替换；留空则保持不变。' : '代理无需认证时留空即可')}</p>
                    {settings.proxy_password_set && <button type="button" className="btn btn-outline" disabled={!proxyDraft.proxy_enabled} onClick={() => { patchDraft('proxy_password', ''); patchDraft('clear_proxy_password', true); }}>{t("清除已保存密码")}</button>}
                  </div>
                )}
              </div>

              <p className="settings-hint">{t("测试仅检查接口与下载访问红果官网的连接，不代表发现页等浏览器请求的代理状态。")}</p>
              {testResult && (
                <div className={`proxy-test-result ${testResult.success ? 'ok' : 'fail'}`}>
                  {testResult.success ? <Check size={15} /> : <AlertCircle size={15} />}
                  <span>
                    {t(testResult.success ? testResult.message : testResult.error)}
                    {testResult.success && testResult.via ? t(' · 经由 {0}', [testResult.via === '(直连)' ? t('(直连)') : testResult.via]) : ''}
                  </span>
                </div>
              )}
              {saveError && <p className="alert alert-error" role="alert">{t(saveError)}</p>}
            </fieldset>

            <div className="proxy-modal-foot">
              <button className="btn btn-outline" onClick={runTest} disabled={testing || saving}>
                <RefreshCw size={15} />
                {t(testing ? '测试中...' : '测试连接')}
              </button>
              <div className="proxy-foot-right">
                <button className="btn btn-outline" disabled={saving} onClick={closeProxy}>{t("取消")}</button>
                <button className="btn btn-primary" disabled={saving} onClick={applyProxy}>
                  <Check size={15} />
                  {t(saving ? '正在保存…' : '保存并生效')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SettingsPage;
