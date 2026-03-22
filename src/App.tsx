import { useEffect, useMemo, useRef, useState } from "react";
import { save, open, confirm, message as showDialogMessage } from "@tauri-apps/plugin-dialog";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { downloadDir } from "@tauri-apps/api/path";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";

type Status = "idle" | "converting" | "success" | "error";

type ImageItem = {
  id: string;
  path: string;
  rotation: number;
  previewUrl?: string;
};

type ServerInfo = {
  running: boolean;
  port: number | null;
  shared_dir: string | null;
  transfer_mode: TransferMode;
  ips: string[];
  urls: string[];
};

type TransferMode = "upload_only" | "download_only" | "upload_download";

const imageExts = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"];

export default function App() {
  const [route, setRoute] = useState(window.location.hash);
  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    return (localStorage.getItem("theme") as "light" | "dark" | "system") || "system";
  });

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
    localStorage.setItem("theme", theme);

    // Communicate theme change across windows
    localStorage.setItem("themeSync", `${theme}-${Date.now()}`);
  }, [theme]);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "themeSync") {
        const newTheme = localStorage.getItem("theme") as "light" | "dark" | "system";
        if (newTheme && newTheme !== theme) {
          setTheme(newTheme);
        }
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [theme]);

  // Listen for system theme changes if set to system
  useEffect(() => {
    if (theme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const root = window.document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(mediaQuery.matches ? "dark" : "light");
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => {
      if (prev === "system") return "light";
      if (prev === "light") return "dark";
      return "system";
    });
  };

  if (route === "#/preview") {
    return <PreviewApp toggleTheme={toggleTheme} theme={theme} />;
  }

  return <MainApp toggleTheme={toggleTheme} theme={theme} />;
}

function MainApp({ toggleTheme, theme }: { toggleTheme: () => void, theme: string }) {
  const [activeFeature, setActiveFeature] = useState<"pdf" | "transfer">("pdf");
  const [images, setImages] = useState<ImageItem[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  const canConvert = useMemo(() => images.length > 0 && status !== "converting", [images.length, status]);

  // Load from localStorage if available (syncing from preview window)
  useEffect(() => {
    const handleStorage = () => {
      try {
        const data = JSON.parse(localStorage.getItem('previewData') || '{}');
        if (data.images && Array.isArray(data.images)) {
          setImages(data.images);
        }
      } catch (e) {}
    };
    handleStorage();
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    if (status !== "success" || !message) return;
    const timer = window.setTimeout(() => {
      setMessage("");
      setStatus("idle");
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [status, message]);

  useEffect(() => {
    void handleCheckUpdate(false);
  }, []);

  useEffect(() => {
    const title = activeFeature === "pdf" ? "图片转 PDF" : "文件传输";
    document.title = title;
    void getCurrentWebviewWindow().setTitle(title);
  }, [activeFeature]);

  async function handleCheckUpdate(showLatestMessage: boolean) {
    if (isCheckingUpdate) return;
    setIsCheckingUpdate(true);

    try {
      const update = await check();
      if (!update) {
        if (showLatestMessage) {
          await showDialogMessage("当前已是最新版本", {
            title: "检查更新",
            kind: "info",
          });
        }
        return;
      }

      const releaseNotes =
        typeof update.body === "string" && update.body.trim().length > 0
          ? update.body.trim()
          : "暂无更新说明";

      const shouldInstall = await confirm(
        `更新内容：\n${releaseNotes}`,
        {
          title: `检测到新版本 v${update.version}`,
          kind: "info",
          okLabel: "立即更新",
          cancelLabel: "稍后",
        },
      );
      if (!shouldInstall) {
        return;
      }

      await update.downloadAndInstall();
      await relaunch();
    } catch (error) {
      const msg = String(error);
      await showDialogMessage(`检查更新失败：${msg}`, {
        title: "更新失败",
        kind: "error",
      });
    } finally {
      setIsCheckingUpdate(false);
    }
  }

  async function pickImages() {
    const selected = await open({
      directory: false,
      multiple: true,
      filters: [{ name: "Images", extensions: imageExts }],
    });
    if (!selected) return;

    const paths = Array.isArray(selected) ? selected : [selected];
    const existing = new Set(images.map((item) => item.path));
    const newPaths = paths.filter((path) => !existing.has(path));

    const newItems = await Promise.all(
      newPaths.map(async (path) => ({
        id: crypto.randomUUID(),
        path,
        rotation: 0,
        previewUrl: await createPreviewUrl(path),
      })),
    );

    const newImages = [...images, ...newItems];
    updateMainImages(newImages);
    setStatus("idle");
    setMessage("");
  }

  function getSavedForceA4(): boolean {
    try {
      const data = JSON.parse(localStorage.getItem('previewData') || '{}');
      if (data.forceA4 !== undefined) return Boolean(data.forceA4);
    } catch (e) {}
    return false;
  }

  function updateMainImages(newImages: ImageItem[]) {
    setImages(newImages);
    localStorage.setItem('previewData', JSON.stringify({ images: newImages, forceA4: getSavedForceA4() }));
  }

  function removeItem(id: string) {
    const newImages = images.filter((item) => item.id !== id);
    updateMainImages(newImages);
  }

  function clearAllImages() {
    updateMainImages([]);
  }

  function moveItem(index: number, direction: 'up' | 'down') {
    if (status === "converting") return;
    if (direction === 'up' && index > 0) {
      const newImages = [...images];
      [newImages[index - 1], newImages[index]] = [newImages[index], newImages[index - 1]];
      updateMainImages(newImages);
    } else if (direction === 'down' && index < images.length - 1) {
      const newImages = [...images];
      [newImages[index], newImages[index + 1]] = [newImages[index + 1], newImages[index]];
      updateMainImages(newImages);
    }
  }

  function rotateItem(id: string, delta: 90 | -90) {
    if (status === "converting") return;
    const newImages = images.map((item) =>
      item.id === id
        ? {
            ...item,
            rotation: normalizeRotation(item.rotation + delta),
          }
        : item
    );
    updateMainImages(newImages);
  }

  async function openPreviewAndExport() {
    if (images.length === 0 || status === "converting") return;
    
    let forceA4 = false;
    try {
      const data = JSON.parse(localStorage.getItem('previewData') || '{}');
      if (data.forceA4 !== undefined) forceA4 = data.forceA4;
    } catch(e) {}
    localStorage.setItem('previewData', JSON.stringify({ images, forceA4 }));
    
    try {
      const existing = await WebviewWindow.getByLabel('preview');
      if (existing) {
        await existing.show();
        await existing.setFocus();
        return;
      }
    } catch (e) {
      console.error('Error checking existing window:', e);
    }

    try {
      const webview = new WebviewWindow('preview', {
        url: 'index.html#/preview',
        title: '导出前预览',
        width: 480,
        height: 800,
        minWidth: 420,
        minHeight: 640,
        center: true,
        resizable: true,
      });

      webview.once('tauri://error', function (e) {
        console.error('Error creating window', e);
        setMessage(`创建预览窗口失败(tauri://error): ${JSON.stringify(e)}`);
      });
    } catch (e) {
      console.error('Error instantiating WebviewWindow', e);
      setMessage(`创建预览窗口失败: ${String(e)}`);
    }
  }

  return (
    <main className="workspace-shell">
      <aside className="feature-sidebar">
        <h3 className="feature-title">功能</h3>
        <button
          className={`feature-nav-btn ${activeFeature === "pdf" ? "active" : ""}`}
          onClick={() => setActiveFeature("pdf")}
        >
          <span className="feature-nav-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/><path d="M9 19h6"/></svg>
          </span>
          <span>图片转 PDF</span>
        </button>
        <button
          className={`feature-nav-btn ${activeFeature === "transfer" ? "active" : ""}`}
          onClick={() => setActiveFeature("transfer")}
        >
          <span className="feature-nav-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/></svg>
          </span>
          <span>文件传输</span>
        </button>
        <section className="card panel global-toolbar sidebar-global-toolbar">
          <div className="global-toolbar-actions">
            <button className="btn-ghost" onClick={() => void handleCheckUpdate(true)} disabled={isCheckingUpdate}>
              {isCheckingUpdate ? "检查中..." : "检查更新"}
            </button>
            <button className="btn-ghost icon-btn" onClick={toggleTheme} title={`切换主题 (当前: ${theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'})`}>
              {theme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
              ) : theme === 'light' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
              )}
            </button>
          </div>
        </section>
      </aside>

      <section className="workspace-content">
        {activeFeature === "pdf" ? (
          <div className="app-shell app-shell-in-workspace">
            <section className="hero card">
              <div className="hero-top">
                <h1>图片转 PDF</h1>
                <span className="meta-badge">已添加 {images.length} 张</span>
              </div>
              <p>选择多张图片，按顺序导出为单个 PDF 文档。</p>
            </section>

            <section className="card panel">
              <div className="panel-header">
                <h2>1. 添加图片</h2>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {images.length > 0 && (
                    <button className="btn-ghost danger" onClick={clearAllImages} disabled={status === "converting"}>
                      清空全部
                    </button>
                  )}
                </div>
              </div>

              {images.length === 0 ? (
                <button
                  type="button"
                  className="empty-state empty-state-action"
                  onClick={pickImages}
                  disabled={status === "converting"}
                >
                  点击“添加图片”开始创建 PDF
                </button>
              ) : (
                <ul className="image-grid">
                  {images.map((item, index) => (
                    <li
                      key={item.id}
                      className="image-tile"
                    >
                      <div className="image-tile-head">
                        <span className="index">{index + 1}</span>
                        <button className="btn-ghost danger icon-btn" onClick={() => removeItem(item.id)} disabled={status === "converting"}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                        </button>
                      </div>
                      <div className="image-tile-canvas">
                        {item.previewUrl ? (
                          <div className="thumb-stage">
                            <img
                              src={item.previewUrl}
                              alt={`图片 ${index + 1}`}
                              className="thumb"
                              style={{ transform: `rotate(${item.rotation}deg)` }}
                            />
                          </div>
                        ) : (
                          <div className="thumb-placeholder">无预览</div>
                        )}
                      </div>
                      <div className="image-tile-actions">
                        {index > 0 && (
                          <button
                            className="btn-ghost icon-btn"
                            aria-label="左移一张"
                            title="左移一张"
                            onClick={() => moveItem(index, 'up')}
                            disabled={status === "converting"}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
                          </button>
                        )}
                        {index < images.length - 1 && (
                          <button
                            className="btn-ghost icon-btn"
                            aria-label="右移一张"
                            title="右移一张"
                            onClick={() => moveItem(index, 'down')}
                            disabled={status === "converting"}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
                          </button>
                        )}
                        <div className="image-tile-actions-divider" />
                        <button
                          className="btn-ghost icon-btn"
                          aria-label="左转90度"
                          title="左转90度"
                          onClick={() => rotateItem(item.id, -90)}
                          disabled={status === "converting"}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                        </button>
                        <button
                          className="btn-ghost icon-btn"
                          aria-label="右转90度"
                          title="右转90度"
                          onClick={() => rotateItem(item.id, 90)}
                          disabled={status === "converting"}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                        </button>
                      </div>
                      <p className="image-tile-label">图片 {index + 1}</p>
                    </li>
                  ))}
                  <li className="image-tile image-add-tile">
                    <button
                      type="button"
                      className="image-add-trigger"
                      onClick={pickImages}
                      disabled={status === "converting"}
                      aria-label="添加图片"
                      title="添加图片"
                    >
                      <span className="image-add-icon">+</span>
                      <span className="image-add-label">添加图片</span>
                    </button>
                  </li>
                </ul>
              )}
            </section>

            <section className="card panel">
              <p className="output-path">点击“预览并导出 PDF”后，将在新窗口进行排序、旋转、选择版式和确认导出。</p>
            </section>

            <section className="card panel footer-panel">
              <button className="btn-primary wide" onClick={openPreviewAndExport} disabled={!canConvert}>
                {status === "converting" ? "转换中..." : "预览并导出 PDF"}
              </button>
              {message && <p className={`message ${status}`}>{message}</p>}
            </section>
          </div>
        ) : (
          <FileTransferPanel />
        )}
      </section>
    </main>
  );
}

function FileTransferPanel() {
  const [sharedDir, setSharedDir] = useState("");
  const [port, setPort] = useState("8787");
  const [transferMode, setTransferMode] = useState<TransferMode>("upload_download");
  const [isEditingSharedDir, setIsEditingSharedDir] = useState(false);
  const [isEditingPort, setIsEditingPort] = useState(false);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showSharedFilesModal, setShowSharedFilesModal] = useState(false);
  const [sharedFiles, setSharedFiles] = useState<Array<{ name: string; size: number; modified_unix: number | null; path: string }>>([]);
  const [sharedFilesLoading, setSharedFilesLoading] = useState(false);
  const [sharedFilesError, setSharedFilesError] = useState("");
  const [sharedFilesQuery, setSharedFilesQuery] = useState("");
  const [sharedFilesSort, setSharedFilesSort] = useState<"mtime_desc" | "name_asc" | "size_desc">("mtime_desc");
  const [sharedFileFirstSeenMs, setSharedFileFirstSeenMs] = useState<Record<string, number>>({});
  const [sharedFileHighlightNow, setSharedFileHighlightNow] = useState(() => Date.now());
  const sharedFilesRefreshingRef = useRef(false);

  const canStart = useMemo(
    () => !isWorking && sharedDir.trim().length > 0,
    [isWorking, sharedDir],
  );
  const effectiveMode: TransferMode = serverInfo?.running ? (serverInfo.transfer_mode ?? transferMode) : transferMode;
  const canDownload = effectiveMode !== "upload_only";
  const urls = serverInfo?.urls ?? [];
  const activeUrl = urls[0] || "";
  const filteredSharedFiles = useMemo(() => {
    const q = sharedFilesQuery.trim().toLowerCase();
    const source = q ? sharedFiles.filter((f) => f.name.toLowerCase().includes(q)) : sharedFiles;
    const sorted = [...source];
    if (sharedFilesSort === "name_asc") {
      sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    } else if (sharedFilesSort === "size_desc") {
      sorted.sort((a, b) => b.size - a.size);
    } else {
      sorted.sort((a, b) => (b.modified_unix ?? 0) - (a.modified_unix ?? 0));
    }
    return sorted;
  }, [sharedFiles, sharedFilesQuery, sharedFilesSort]);

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    void initDefaultSharedDir();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function refreshStatus() {
    try {
      const info = await invoke<ServerInfo>("get_file_server_status");
      setServerInfo(info);
      if (info.shared_dir) {
        setSharedDir(info.shared_dir);
      }
      if (info.port) {
        setPort(String(info.port));
      }
      if (info.transfer_mode) {
        setTransferMode(info.transfer_mode);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function initDefaultSharedDir() {
    try {
      const dir = await downloadDir();
      setSharedDir((prev) => prev || dir);
    } catch {
      // Ignore: some environments may not resolve download directory.
    }
  }

  async function pickSharedFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    setSharedDir(selected);
    setError("");
  }

  async function startServer() {
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError("端口必须是 1-65535 的整数");
      return;
    }
    if (!sharedDir.trim()) {
      setError("请先选择共享目录");
      return;
    }

    setIsWorking(true);
    setError("");
    try {
      const info = await invoke<ServerInfo>("start_file_server", { sharedDir, port: portNum, transferMode });
      setServerInfo(info);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsWorking(false);
    }
  }

  async function stopServer() {
    setIsWorking(true);
    setError("");
    try {
      await invoke("stop_file_server");
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsWorking(false);
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("地址已复制");
    } catch (e) {
      setError(`复制失败: ${String(e)}`);
    }
  }

  async function copyAllUrls() {
    if (!urls.length) return;
    try {
      await navigator.clipboard.writeText(urls.join("\n"));
      setNotice(`已复制 ${urls.length} 个地址`);
    } catch (e) {
      setError(`复制失败: ${String(e)}`);
    }
  }

  async function openSharedFilesModal() {
    if (!canDownload) {
      setError("当前模式未开启下载");
      return;
    }
    const targetSharedDir = (serverInfo?.shared_dir ?? sharedDir).trim();
    if (!targetSharedDir) {
      setError("请先选择共享目录");
      return;
    }

    setShowSharedFilesModal(true);
    setSharedFilesQuery("");
    setSharedFilesSort("mtime_desc");
    await refreshSharedFiles(targetSharedDir, false);
  }

  async function refreshSharedFiles(targetSharedDir: string, silent: boolean) {
    if (!targetSharedDir || sharedFilesRefreshingRef.current) return;
    sharedFilesRefreshingRef.current = true;
    if (!silent) {
      setSharedFilesLoading(true);
      setSharedFilesError("");
    }
    try {
      const files = await invoke<Array<{ name: string; size: number; modified_unix: number | null; path: string }>>("list_shared_files", {
        sharedDir: targetSharedDir,
      });
      setSharedFiles(files);
      setSharedFileFirstSeenMs((prev) => {
        const now = Date.now();
        const next: Record<string, number> = {};
        for (const file of files) {
          next[file.path] = prev[file.path] ?? now;
        }
        return next;
      });
      if (silent) setSharedFilesError("");
    } catch (e) {
      setSharedFilesError(String(e));
      if (!silent) setSharedFiles([]);
    } finally {
      if (!silent) setSharedFilesLoading(false);
      sharedFilesRefreshingRef.current = false;
    }
  }

  async function openLocalFile(path: string) {
    try {
      await invoke("open_local_file", { path });
    } catch (e) {
      setSharedFilesError(`打开文件失败: ${String(e)}`);
    }
  }

  async function openFileLocation(path: string) {
    try {
      await invoke("open_file_location", { path });
    } catch (e) {
      setSharedFilesError(`打开目录失败: ${String(e)}`);
    }
  }

  useEffect(() => {
    if (!showSharedFilesModal) return;
    const targetSharedDir = (serverInfo?.shared_dir ?? sharedDir).trim();
    if (!targetSharedDir) return;

    const timer = window.setInterval(() => {
      void refreshSharedFiles(targetSharedDir, true);
    }, 2000);

    return () => window.clearInterval(timer);
  }, [showSharedFilesModal, serverInfo?.shared_dir, sharedDir]);

  useEffect(() => {
    if (!showSharedFilesModal) return;
    const timer = window.setInterval(() => {
      setSharedFileHighlightNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [showSharedFilesModal]);

  useEffect(() => {
    if (canDownload) return;
    setShowSharedFilesModal(false);
  }, [canDownload]);

  return (
    <div className="app-shell app-shell-in-workspace">
      <section className="hero card">
        <div className="hero-top">
          <h1>文件传输</h1>
          <span
            className={`service-status-dot ${serverInfo?.running ? "is-running" : "is-stopped"}`}
            title={serverInfo?.running ? "服务已启动" : "服务未启动"}
            aria-label={serverInfo?.running ? "服务已启动" : "服务未启动"}
          />
        </div>
        <p>
          {effectiveMode === "upload_only"
            ? "同一局域网内访问 `IP:端口`，当前仅支持上传，文件会保存到共享目录（支持 Windows / Linux）。"
            : effectiveMode === "download_only"
              ? "同一局域网内访问 `IP:端口`，当前仅支持下载共享目录中的文件（支持 Windows / Linux）。"
              : "同一局域网内访问 `IP:端口`，当前同时支持上传和下载，文件都使用共享目录（支持 Windows / Linux）。"}
        </p>
        {serverInfo?.running && activeUrl ? (
          <div className="transfer-hero-actions">
            <a className="transfer-hero-link" href={activeUrl} target="_blank" rel="noreferrer">
              打开传输页面
            </a>
            <button className="btn-ghost" onClick={() => void copyUrl(activeUrl)}>复制主地址</button>
          </div>
        ) : null}
      </section>

      <section className="card panel transfer-compact-panel">
        <div className="panel-header"><h2>配置与控制台</h2></div>
        <div className="transfer-config-grid">
          <div className="transfer-field">
            <label>传输模式</label>
            <div className="transfer-mode-toggle" role="radiogroup" aria-label="传输模式">
              <button
                type="button"
                className={`transfer-mode-btn ${transferMode === "upload_only" ? "active" : ""}`}
                onClick={() => setTransferMode("upload_only")}
                disabled={isWorking || Boolean(serverInfo?.running)}
                aria-pressed={transferMode === "upload_only"}
              >
                仅上传
              </button>
              <button
                type="button"
                className={`transfer-mode-btn ${transferMode === "download_only" ? "active" : ""}`}
                onClick={() => setTransferMode("download_only")}
                disabled={isWorking || Boolean(serverInfo?.running)}
                aria-pressed={transferMode === "download_only"}
              >
                仅下载
              </button>
              <button
                type="button"
                className={`transfer-mode-btn ${transferMode === "upload_download" ? "active" : ""}`}
                onClick={() => setTransferMode("upload_download")}
                disabled={isWorking || Boolean(serverInfo?.running)}
                aria-pressed={transferMode === "upload_download"}
              >
                上传下载
              </button>
            </div>
          </div>
          <div className="transfer-field">
            <label>共享目录（上传和下载都使用这个目录）</label>
            <div className="transfer-inline">
              <div className="transfer-input-wrap">
                <input
                  className={`transfer-input ${!isEditingSharedDir ? "is-readonly" : ""}`}
                  placeholder="例如：D:\\Share 或 /mnt/data/share"
                  value={sharedDir}
                  onChange={(e) => setSharedDir(e.target.value)}
                  readOnly={!isEditingSharedDir}
                />
                <button
                  type="button"
                  className="transfer-inline-icon-btn secondary"
                  title="选择目录"
                  aria-label="选择目录"
                  onClick={() => void pickSharedFolder()}
                  disabled={isWorking}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
                    <path d="M3 10h18l-1.2 8a2 2 0 0 1-2 1.7H6.2a2 2 0 0 1-2-1.7L3 10z" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`transfer-inline-icon-btn ${isEditingSharedDir ? "active" : ""}`}
                  title={isEditingSharedDir ? "完成编辑" : "编辑目录"}
                  aria-label={isEditingSharedDir ? "完成编辑目录" : "编辑目录"}
                  onClick={() => setIsEditingSharedDir((prev) => !prev)}
                >
                  {isEditingSharedDir ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                      <path d="m12 20 9-9-3-3-9 9-2 5 5-2z" />
                      <path d="m16 8 3 3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
          <div className="transfer-field transfer-port-row">
            <label>端口</label>
            <div className="transfer-input-wrap">
              <input
                className={`transfer-input ${!isEditingPort ? "is-readonly" : ""}`}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="8787"
                readOnly={!isEditingPort}
              />
              <button
                type="button"
                className={`transfer-inline-icon-btn ${isEditingPort ? "active" : ""}`}
                title={isEditingPort ? "完成编辑" : "编辑端口"}
                aria-label={isEditingPort ? "完成编辑端口" : "编辑端口"}
                onClick={() => setIsEditingPort((prev) => !prev)}
              >
                {isEditingPort ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                    <path d="m12 20 9-9-3-3-9 9-2 5 5-2z" />
                    <path d="m16 8 3 3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="transfer-actions">
          <button
            className={`btn-primary transfer-toggle-btn ${serverInfo?.running ? "is-stop" : ""}`}
            onClick={serverInfo?.running ? stopServer : startServer}
            disabled={serverInfo?.running ? isWorking : !canStart}
          >
            {isWorking ? "处理中..." : serverInfo?.running ? "停止服务" : "启动服务"}
          </button>
          {canDownload ? (
            <button className="btn-ghost transfer-shared-btn" onClick={() => void openSharedFilesModal()} disabled={isWorking}>
              查看共享文件
            </button>
          ) : null}
        </div>

        <p className="transfer-inline-hint">
          {effectiveMode === "upload_only"
            ? "提示：当前只允许上传到共享目录。"
            : effectiveMode === "download_only"
              ? "提示：当前只允许下载共享目录中的文件。"
              : "提示：共享目录里的文件可下载；别人上传的文件也会保存到同一目录。"}
        </p>
        {notice && <p className="message success">{notice}</p>}
        {error && <p className="message error">{error}</p>}
      </section>

      <section className="card panel transfer-address-panel">
        <div className="panel-header">
          <h2>访问地址</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost" onClick={() => void copyAllUrls()} disabled={!urls.length}>复制全部</button>
          </div>
        </div>

        {serverInfo?.running && urls.length > 0 ? (
          <ul className="transfer-url-list-compact">
            {urls.map((url, idx) => (
              <li key={url} className="transfer-url-row">
                <span className="transfer-url-row-index">#{idx + 1}</span>
                <a className="transfer-url-row-link" href={url} target="_blank" rel="noreferrer">{url}</a>
                <button
                  className="transfer-copy-icon-btn"
                  onClick={() => void copyUrl(url)}
                  title="复制地址"
                  aria-label="复制地址"
                >
                  <span className="transfer-copy-icon-glyph">⧉</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">启动后会在这里显示可访问地址</div>
        )}
      </section>

      {showSharedFilesModal && (
        <div className="transfer-modal-backdrop" onClick={() => setShowSharedFilesModal(false)}>
          <div className="transfer-modal card" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header transfer-modal-header">
              <div>
                <h2>共享目录文件列表</h2>
                <p className="transfer-modal-subtitle">可直接打开文件，或定位到文件所在目录</p>
              </div>
              <button className="btn-ghost transfer-close-btn" onClick={() => setShowSharedFilesModal(false)}>关闭</button>
            </div>

            <div className="transfer-modal-toolbar">
              <input
                className="transfer-input"
                value={sharedFilesQuery}
                onChange={(e) => setSharedFilesQuery(e.target.value)}
                placeholder="搜索文件名..."
              />
              <select
                className="transfer-sort-select"
                value={sharedFilesSort}
                onChange={(e) => setSharedFilesSort(e.target.value as "mtime_desc" | "name_asc" | "size_desc")}
              >
                <option value="mtime_desc">按时间（最新）</option>
                <option value="name_asc">按名称（A-Z）</option>
                <option value="size_desc">按大小（从大到小）</option>
              </select>
              <span className="transfer-modal-count">
                共 {filteredSharedFiles.length} / {sharedFiles.length} 个
              </span>
            </div>

            {sharedFilesLoading ? (
              <div className="empty-state">正在读取共享目录文件...</div>
            ) : sharedFilesError ? (
              <div className="empty-state">{sharedFilesError}</div>
            ) : filteredSharedFiles.length > 0 ? (
              <ul className="transfer-shared-list">
                {filteredSharedFiles.map((file) => (
                  <li
                    key={file.path}
                    className={`transfer-shared-item ${sharedFileHighlightNow - (sharedFileFirstSeenMs[file.path] ?? 0) <= 5000 ? "is-new" : ""}`}
                  >
                    <div className="transfer-shared-item-main">
                      <p className="transfer-shared-name">{file.name}</p>
                      <p className="transfer-shared-meta">{formatBytes(file.size)} · {formatUnixTime(file.modified_unix)}</p>
                    </div>
                    <div className="transfer-shared-actions">
                      <button
                        className="transfer-action-btn"
                        title="打开文件"
                        aria-label="打开文件"
                        onClick={() => void openLocalFile(file.path)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                          <path d="M14 3h7v7" />
                          <path d="M10 14 21 3" />
                          <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                        </svg>
                        <span>打开</span>
                      </button>
                      <button
                        className="transfer-action-btn"
                        title="打开文件所在目录"
                        aria-label="打开文件所在目录"
                        onClick={() => void openFileLocation(file.path)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
                          <path d="M3 10h18l-1.2 8a2 2 0 0 1-2 1.7H6.2a2 2 0 0 1-2-1.7L3 10z" />
                        </svg>
                        <span>定位</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state">没有匹配的文件</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewApp({ toggleTheme, theme }: { toggleTheme: () => void, theme: string }) {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [forceA4, setForceA4] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    try {
      const data = JSON.parse(localStorage.getItem('previewData') || '{}');
      if (data.images) setImages(data.images);
      if (data.forceA4 !== undefined) setForceA4(data.forceA4);
    } catch (e) {}

    const handleStorage = () => {
      try {
        const data = JSON.parse(localStorage.getItem('previewData') || '{}');
        if (data.images && Array.isArray(data.images)) {
          setImages(data.images);
        }
        if (data.forceA4 !== undefined) setForceA4(data.forceA4);
      } catch (e) {}
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    if (status !== "success" || !message) return;
    const timer = window.setTimeout(() => {
      setMessage("");
      setStatus("idle");
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [status, message]);

  function updateMainState(newImages: ImageItem[]) {
    setImages(newImages);
    localStorage.setItem('previewData', JSON.stringify({ images: newImages, forceA4 }));
  }

  function rotateItem(id: string, delta: 90 | -90) {
    const newImages = images.map((item) =>
      item.id === id
        ? {
            ...item,
            rotation: normalizeRotation(item.rotation + delta),
          }
        : item
    );
    updateMainState(newImages);
  }

  function moveItem(index: number, direction: 'up' | 'down') {
    if (status === "converting") return;
    if (direction === 'up' && index > 0) {
      const newImages = [...images];
      [newImages[index - 1], newImages[index]] = [newImages[index], newImages[index - 1]];
      updateMainState(newImages);
    } else if (direction === 'down' && index < images.length - 1) {
      const newImages = [...images];
      [newImages[index], newImages[index + 1]] = [newImages[index + 1], newImages[index]];
      updateMainState(newImages);
    }
  }

  async function confirmExport() {
    if (images.length === 0 || status === "converting") return;

    const outputPath = await save({
      defaultPath: "output.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!outputPath) return;

    setStatus("converting");
    setMessage("正在转换，请稍候...");

    try {
      await invoke("images_to_pdf", {
        outputPath,
        forceA4,
        images: images.map((item) => ({
          path: item.path,
          rotationDeg: item.rotation,
        })),
      });
      setStatus("success");
      setMessage(`转换成功，PDF 已保存到：${basename(outputPath)}`);
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  return (
    <main className="app-shell preview-only-shell">
      <div className="preview-modal preview-window">
        <div className="panel-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h2>导出前预览</h2>
            <span className="preview-count">共 {images.length} 页</span>
          </div>
          <button className="btn-ghost icon-btn" onClick={toggleTheme} title={`切换主题 (当前: ${theme === 'system' ? '跟随系统' : theme === 'dark' ? '深色' : '浅色'})`}>
            {theme === 'dark' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            ) : theme === 'light' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>
            )}
          </button>
        </div>
        <ul className="image-list preview-list">
          {images.map((item, index) => (
            <li
              key={`preview-${item.id}`}
              className="image-list-item preview-page-item"
            >
              <div className="preview-page">
                <div className="preview-page-label">第 {index + 1} 页</div>
                <div className={`preview-canvas ${forceA4 ? 'is-a4' : ''}`}>
                  {item.previewUrl ? (
                    <div className="thumb-stage">
                      <img
                        src={item.previewUrl}
                        alt={`第 ${index + 1} 页`}
                        className="thumb"
                        style={{ transform: `rotate(${item.rotation}deg)` }}
                      />
                    </div>
                  ) : (
                    <div className="thumb-placeholder">无预览</div>
                  )}
                </div>
                <div className="actions preview-actions">
                  {index > 0 && (
                    <button
                      className="btn-ghost icon-btn"
                      aria-label="上移一页"
                      title="上移一页"
                      onClick={() => moveItem(index, 'up')}
                      disabled={status === "converting"}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
                    </button>
                  )}
                  {index < images.length - 1 && (
                    <button
                      className="btn-ghost icon-btn"
                      aria-label="下移一页"
                      title="下移一页"
                      onClick={() => moveItem(index, 'down')}
                      disabled={status === "converting"}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                  )}
                  <div className="preview-actions-divider" />
                  <button
                    className="btn-ghost icon-btn"
                    aria-label="左转90度"
                    title="左转90度"
                    onClick={() => rotateItem(item.id, -90)}
                    disabled={status === "converting"}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                  </button>
                  <button
                    className="btn-ghost icon-btn"
                    aria-label="右转90度"
                    title="右转90度"
                    onClick={() => rotateItem(item.id, 90)}
                    disabled={status === "converting"}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="preview-footer">
          <label className="option-check" style={{ marginRight: 'auto' }}>
            <input
              type="checkbox"
              checked={forceA4}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setForceA4(checked);
                localStorage.setItem('previewData', JSON.stringify({ images, forceA4: checked }));
              }}
              disabled={status === "converting"}
            />
            <span>统一输出为 A4（竖版）</span>
          </label>
          {message && <span className={`message ${status}`}>{message}</span>}
          <button className="btn-ghost" onClick={() => getCurrentWebviewWindow().close()} disabled={status === "converting"}>
            关闭
          </button>
          <button className="btn-primary" onClick={confirmExport} disabled={status === "converting"}>
            {status === "converting" ? "转换中..." : "确认导出"}
          </button>
        </div>
      </div>
    </main>
  );
}

function basename(path: string): string {
  return path.split(/[\/]/).pop() || path;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(fixed)} ${units[unit]}`;
}

function formatUnixTime(unix: number | null): string {
  if (!unix) return "时间未知";
  return new Date(unix * 1000).toLocaleString();
}

function normalizeRotation(rotation: number): number {
  const r = rotation % 360;
  return r < 0 ? r + 360 : r;
}

async function createPreviewUrl(path: string): Promise<string | undefined> {
  try {
    return convertFileSrc(path);
  } catch {
    return undefined;
  }
}
