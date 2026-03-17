import { useEffect, useMemo, useState } from "react";
import { save, open, confirm, message as showDialogMessage } from "@tauri-apps/plugin-dialog";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
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
  const [images, setImages] = useState<ImageItem[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [appVersion, setAppVersion] = useState("1.0.0");
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
    let alive = true;
    getVersion()
      .then((version) => {
        if (alive) setAppVersion(version);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void handleCheckUpdate(false);
  }, []);

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
    setImages(newImages);
    
    // Preserve forceA4 setting when updating images from MainApp
    let forceA4 = false;
    try {
      const data = JSON.parse(localStorage.getItem('previewData') || '{}');
      if (data.forceA4 !== undefined) forceA4 = data.forceA4;
    } catch(e) {}
    localStorage.setItem('previewData', JSON.stringify({ images: newImages, forceA4 }));
    
    setStatus("idle");
    setMessage("");
  }

  function removeItem(id: string) {
    const newImages = images.filter((item) => item.id !== id);
    setImages(newImages);
    let forceA4 = false;
    try {
      const data = JSON.parse(localStorage.getItem('previewData') || '{}');
      if (data.forceA4 !== undefined) forceA4 = data.forceA4;
    } catch(e) {}
    localStorage.setItem('previewData', JSON.stringify({ images: newImages, forceA4 }));
  }

  function clearAllImages() {
    setImages([]);
    let forceA4 = false;
    try {
      const data = JSON.parse(localStorage.getItem('previewData') || '{}');
      if (data.forceA4 !== undefined) forceA4 = data.forceA4;
    } catch(e) {}
    localStorage.setItem('previewData', JSON.stringify({ images: [], forceA4 }));
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
    <main className="app-shell">
      <section className="hero card">
        <div className="hero-top">
          <h1>图片转 PDF</h1>
          <span className="meta-badge">已添加 {images.length} 张</span>
          <span className="meta-badge">v{appVersion}</span>
          <div style={{ flex: 1 }} />
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
            <button className="btn-primary" onClick={pickImages} disabled={status === "converting"}>
              添加图片
            </button>
          </div>
        </div>

        {images.length === 0 ? (
          <div className="empty-state">点击“添加图片”开始创建 PDF</div>
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
                      />
                    </div>
                  ) : (
                    <div className="thumb-placeholder">无预览</div>
                  )}
                </div>
                <p className="image-tile-label">图片 {index + 1}</p>
              </li>
            ))}
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
    </main>
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
