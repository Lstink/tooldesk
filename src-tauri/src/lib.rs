mod pdf;

use axum::extract::{Multipart, Path as AxumPath, State as AxumState};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use if_addrs::get_if_addrs;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::State;
use tokio::sync::oneshot;

#[derive(Clone)]
struct HttpState {
    shared_dir: PathBuf,
}

struct RunningServer {
    port: u16,
    shared_dir: PathBuf,
    shutdown_tx: oneshot::Sender<()>,
    join: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct ServerState {
    inner: Mutex<Option<RunningServer>>,
}

#[derive(Serialize)]
struct ServerInfo {
    running: bool,
    port: Option<u16>,
    shared_dir: Option<String>,
    ips: Vec<String>,
    urls: Vec<String>,
}

#[derive(Serialize)]
struct UploadResult {
    saved: usize,
}

#[derive(Serialize)]
struct SharedFile {
    name: String,
    size: u64,
    modified_unix: Option<u64>,
}

#[derive(Serialize)]
struct LocalSharedFile {
    name: String,
    size: u64,
    modified_unix: Option<u64>,
    path: String,
}

#[tauri::command]
async fn start_file_server(
    state: State<'_, ServerState>,
    shared_dir: String,
    port: Option<u16>,
) -> Result<ServerInfo, String> {
    let requested_port = port.unwrap_or(8787);
    if requested_port == 0 {
        return Err("端口必须在 1-65535 之间".to_string());
    }

    let shared_path = PathBuf::from(&shared_dir);
    if !shared_path.exists() {
        return Err("共享目录不存在".to_string());
    }
    if !shared_path.is_dir() {
        return Err("共享目录不是文件夹".to_string());
    }

    {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "服务状态锁异常".to_string())?;
        if guard.is_some() {
            return Err("服务已经在运行，请先停止".to_string());
        }
    }

    let app_state = HttpState {
        shared_dir: shared_path.clone(),
    };

    let app = Router::new()
        .route("/", get(index_page))
        .route("/upload", post(upload_file))
        .route("/files", get(list_files))
        .route("/download/{name}", get(download_file))
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", requested_port))
        .await
        .map_err(|e| format!("启动监听失败: {e}"))?;
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("读取监听地址失败: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let server = axum::serve(listener, app).with_graceful_shutdown(async {
        let _ = shutdown_rx.await;
    });

    let join = tokio::spawn(async move {
        if let Err(err) = server.await {
            eprintln!("file server stopped with error: {err}");
        }
    });

    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "服务状态锁异常".to_string())?;
        *guard = Some(RunningServer {
            port: actual_port,
            shared_dir: shared_path.clone(),
            shutdown_tx,
            join,
        });
    }

    Ok(build_server_info(Some((actual_port, shared_path))))
}

#[tauri::command]
async fn stop_file_server(state: State<'_, ServerState>) -> Result<(), String> {
    let running = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "服务状态锁异常".to_string())?;
        guard.take()
    };

    if let Some(server) = running {
        let _ = server.shutdown_tx.send(());
        let _ = server.join.await;
        Ok(())
    } else {
        Err("服务未运行".to_string())
    }
}

#[tauri::command]
fn get_file_server_status(state: State<'_, ServerState>) -> Result<ServerInfo, String> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| "服务状态锁异常".to_string())?;
    let snapshot = guard
        .as_ref()
        .map(|s| (s.port, s.shared_dir.clone()));
    Ok(build_server_info(snapshot))
}

fn build_server_info(snapshot: Option<(u16, PathBuf)>) -> ServerInfo {
    let ips = get_local_ipv4s();
    if let Some((port, shared_dir)) = snapshot {
        let urls = ips
            .iter()
            .map(|ip| format!("http://{ip}:{port}"))
            .collect::<Vec<_>>();
        ServerInfo {
            running: true,
            port: Some(port),
            shared_dir: Some(shared_dir.to_string_lossy().to_string()),
            ips,
            urls,
        }
    } else {
        ServerInfo {
            running: false,
            port: None,
            shared_dir: None,
            ips,
            urls: Vec::new(),
        }
    }
}

fn get_local_ipv4s() -> Vec<String> {
    let mut ips = match get_if_addrs() {
        Ok(addrs) => addrs
            .into_iter()
            .filter_map(|iface| {
                let ip = iface.ip();
                if ip.is_ipv4() && !ip.is_loopback() {
                    Some(ip.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };

    ips.sort();
    ips.dedup();

    if ips.is_empty() {
        ips.push("127.0.0.1".to_string());
    }

    ips
}

async fn index_page() -> Html<&'static str> {
    Html(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>局域网文件传输</title>
  <style>
    :root {
      --bg: #f3f6fb;
      --surface: rgba(255, 255, 255, 0.9);
      --surface-strong: #ffffff;
      --border: #dbe3f1;
      --text: #101828;
      --muted: #5d6b85;
      --primary: #1663f6;
      --primary-weak: #e8f0ff;
      --success: #0e9f6e;
      --danger: #dc2626;
      --radius: 16px;
      --radius-sm: 12px;
      --shadow: 0 12px 28px rgba(10, 35, 80, 0.09);
      font-family: "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 14% 10%, #dce9ff 0%, transparent 38%),
        radial-gradient(circle at 86% 0%, #e8f6ff 0%, transparent 28%),
        var(--bg);
    }

    .wrap {
      width: min(1080px, 94vw);
      margin: 34px auto 40px;
      display: grid;
      gap: 16px;
    }

    .hero {
      background: linear-gradient(135deg, #12213f 0%, #1f3767 52%, #2d4d84 100%);
      border-radius: calc(var(--radius) + 2px);
      color: #f8fbff;
      padding: 22px 24px;
      box-shadow: var(--shadow);
    }

    .hero h1 {
      margin: 0;
      font-size: clamp(1.55rem, 3.2vw, 2.1rem);
      letter-spacing: -0.02em;
    }

    .hero p {
      margin: 8px 0 0;
      color: rgba(241, 246, 255, 0.88);
      line-height: 1.58;
      font-size: 0.97rem;
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 330px;
    }

    .card h2 {
      margin: 0;
      font-size: 1.08rem;
      letter-spacing: -0.01em;
    }

    .muted {
      margin: 0;
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.5;
    }

    .upload-drop {
      flex: 1;
      border: 1.5px dashed #9db8e9;
      border-radius: 14px;
      padding: 18px 16px;
      background: linear-gradient(180deg, #f9fbff 0%, #f3f7ff 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      text-align: center;
      transition: transform .14s ease, border-color .14s ease, background .14s ease;
      cursor: pointer;
    }

    .upload-drop:hover {
      transform: translateY(-1px);
      border-color: #6f95dc;
    }

    .upload-drop.dragging {
      border-color: var(--primary);
      background: #eaf1ff;
      transform: scale(1.01);
    }

    .upload-icon {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      background: var(--primary-weak);
      color: var(--primary);
      font-size: 22px;
      font-weight: 700;
    }

    .upload-title {
      margin: 0;
      font-size: 1rem;
      font-weight: 700;
    }

    .upload-sub {
      margin: 0;
      color: var(--muted);
      font-size: 0.88rem;
    }

    .upload-btn {
      border: none;
      border-radius: 999px;
      padding: 8px 14px;
      font-size: 0.88rem;
      font-weight: 600;
      color: #fff;
      background: var(--primary);
      cursor: pointer;
    }

    .upload-btn:disabled {
      opacity: .55;
      cursor: not-allowed;
    }

    .msg {
      min-height: 20px;
      margin: 0;
      font-size: 0.9rem;
      color: var(--muted);
    }

    .msg.success { color: var(--success); }
    .msg.error { color: var(--danger); }

    .upload-queue {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 8px;
      max-height: 180px;
      overflow: auto;
    }

    .upload-item {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface-strong);
      padding: 8px 10px;
      display: grid;
      gap: 6px;
    }

    .upload-item-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }

    .upload-item-name {
      margin: 0;
      font-size: .84rem;
      color: var(--text);
      word-break: break-all;
    }

    .upload-item-state {
      margin: 0;
      font-size: .78rem;
      color: var(--muted);
      white-space: nowrap;
    }

    .upload-item-progress {
      height: 8px;
      border-radius: 999px;
      background: #e9eef8;
      overflow: hidden;
    }

    .upload-item-progress > span {
      display: block;
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #3b82f6 0%, #1d4ed8 100%);
      transition: width .18s ease;
    }

    .upload-item.done .upload-item-state { color: var(--success); }
    .upload-item.error .upload-item-state { color: var(--danger); }

    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .search-input {
      width: min(260px, 60vw);
      height: 36px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--text);
      padding: 0 12px;
      font-size: .86rem;
      outline: none;
    }

    .sort-select {
      height: 36px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--text);
      padding: 0 10px;
      font-size: .86rem;
      outline: none;
    }

    .sort-select:focus {
      border-color: #96b5ef;
      box-shadow: 0 0 0 3px rgba(22, 99, 246, 0.12);
    }

    .search-input:focus {
      border-color: #96b5ef;
      box-shadow: 0 0 0 3px rgba(22, 99, 246, 0.12);
    }

    .refresh-btn {
      border: 1px solid var(--border);
      background: var(--surface-strong);
      border-radius: 10px;
      padding: 7px 12px;
      font-size: .87rem;
      cursor: pointer;
    }

    .file-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 10px;
      overflow-y: auto;
      max-height: 440px;
      padding-right: 3px;
    }

    .file-item {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface-strong);
      padding: 10px 12px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
    }

    .file-item.file-item-new {
      border-color: #9ec0ff;
      background: linear-gradient(0deg, #eef5ff 0%, #ffffff 100%);
    }

    .file-name {
      margin: 0;
      font-size: 0.92rem;
      color: var(--text);
      word-break: break-all;
    }

    .file-meta {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 0.8rem;
    }

    .download-link {
      text-decoration: none;
      color: var(--primary);
      border: 1px solid #c6d9ff;
      background: #edf3ff;
      border-radius: 9px;
      padding: 6px 10px;
      font-size: .82rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .empty {
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--muted);
      text-align: center;
      padding: 24px 12px;
      background: #f8faff;
      font-size: .9rem;
    }

    @media (max-width: 920px) {
      .grid { grid-template-columns: 1fr; }
      .card { min-height: auto; }
      .file-list { max-height: none; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <h1>局域网文件传输</h1>
      <p>上传和下载都使用同一个共享目录。支持点击上传和拖拽上传。</p>
    </section>

    <section class="grid">
      <article class="card">
        <h2>上传文件</h2>
        <p class="muted">把文件拖到下方区域，或者点击选择文件。</p>
        <div id="uploadDrop" class="upload-drop" role="button" tabindex="0" aria-label="上传区域">
          <div class="upload-icon">↑</div>
          <p class="upload-title">拖拽文件到这里上传</p>
          <p class="upload-sub">或点击按钮选择文件（支持多选）</p>
          <button id="pickBtn" class="upload-btn" type="button">选择文件并上传</button>
          <input id="fileInput" type="file" name="file" multiple hidden />
        </div>
        <p id="msg" class="msg"></p>
        <ul id="uploadQueue" class="upload-queue"></ul>
      </article>

      <article class="card">
        <div class="toolbar">
          <h2>下载文件</h2>
          <div class="toolbar-actions">
            <input id="searchInput" class="search-input" type="search" placeholder="搜索文件名，例如：报告.pdf" />
            <select id="sortSelect" class="sort-select" aria-label="排序方式">
              <option value="mtime_desc">按时间（最新）</option>
              <option value="name_asc">按名称（A-Z）</option>
              <option value="size_desc">按大小（从大到小）</option>
            </select>
          </div>
        </div>
        <p class="muted">展示共享目录中的文件，点击即可下载。</p>
        <ul id="fileList" class="file-list"></ul>
      </article>
    </section>
  </main>

  <script>
    const msg = document.getElementById("msg");
    const drop = document.getElementById("uploadDrop");
    const fileInput = document.getElementById("fileInput");
    const pickBtn = document.getElementById("pickBtn");
    const searchInput = document.getElementById("searchInput");
    const sortSelect = document.getElementById("sortSelect");
    const fileList = document.getElementById("fileList");
    const uploadQueue = document.getElementById("uploadQueue");

    let uploading = false;
    let allFiles = [];
    let currentQuery = "";
    let currentSort = "mtime_desc";
    let fileFirstSeenMs = new Map();

    function setMessage(text, type) {
      msg.textContent = text || "";
      msg.className = "msg" + (type ? " " + type : "");
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return "-";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return value.toFixed(value >= 100 || unit === 0 ? 0 : 1) + " " + units[unit];
    }

    function formatTime(unix) {
      if (!unix) return "时间未知";
      const d = new Date(unix * 1000);
      return d.toLocaleString();
    }

    function renderFiles(files) {
      fileList.innerHTML = "";
      if (!Array.isArray(files) || files.length === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = currentQuery ? "没有匹配的文件，请换个关键字试试" : "共享目录暂无文件";
        fileList.appendChild(li);
        return;
      }

      const now = Date.now();
      for (const f of files) {
        const li = document.createElement("li");
        li.className = "file-item";
        const firstSeen = fileFirstSeenMs.get(f.name) || 0;
        if (now - firstSeen <= 5000) {
          li.classList.add("file-item-new");
        }

        const left = document.createElement("div");
        const title = document.createElement("p");
        title.className = "file-name";
        title.textContent = f.name;
        const meta = document.createElement("p");
        meta.className = "file-meta";
        meta.textContent = formatBytes(f.size) + " · " + formatTime(f.modified_unix);
        left.appendChild(title);
        left.appendChild(meta);

        const dl = document.createElement("a");
        dl.className = "download-link";
        dl.href = "/download/" + encodeURIComponent(f.name);
        dl.textContent = "下载";
        dl.setAttribute("download", f.name);

        li.appendChild(left);
        li.appendChild(dl);
        fileList.appendChild(li);
      }
    }

    function renderFilteredFiles() {
      const q = currentQuery.trim().toLowerCase();
      const filtered = q
        ? allFiles.filter((f) => String(f.name || "").toLowerCase().includes(q))
        : [...allFiles];

      if (currentSort === "name_asc") {
        filtered.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
      } else if (currentSort === "size_desc") {
        filtered.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
      } else {
        filtered.sort((a, b) => Number(b.modified_unix || 0) - Number(a.modified_unix || 0));
      }

      renderFiles(filtered);
    }

    async function loadFiles() {
      try {
        const res = await fetch("/files");
        if (!res.ok) throw new Error("读取列表失败");
        const files = await res.json();
        allFiles = Array.isArray(files) ? files : [];
        const now = Date.now();
        const nextSeen = new Map();
        for (const f of allFiles) {
          nextSeen.set(f.name, fileFirstSeenMs.get(f.name) || now);
        }
        fileFirstSeenMs = nextSeen;
        renderFilteredFiles();
      } catch {
        fileList.innerHTML = "";
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "读取文件列表失败，请稍后刷新";
        fileList.appendChild(li);
      }
    }

    function createUploadRow(file) {
      const li = document.createElement("li");
      li.className = "upload-item";
      const head = document.createElement("div");
      head.className = "upload-item-head";
      const name = document.createElement("p");
      name.className = "upload-item-name";
      name.textContent = file.name;
      const state = document.createElement("p");
      state.className = "upload-item-state";
      state.textContent = "等待上传";
      head.appendChild(name);
      head.appendChild(state);

      const progress = document.createElement("div");
      progress.className = "upload-item-progress";
      const bar = document.createElement("span");
      progress.appendChild(bar);

      li.appendChild(head);
      li.appendChild(progress);
      uploadQueue.appendChild(li);
      return { li, state, bar };
    }

    function uploadSingleFile(file, row) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/upload", true);

        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const p = Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100)));
          row.bar.style.width = p + "%";
          row.state.textContent = "上传中 " + p + "%";
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            row.bar.style.width = "100%";
            row.li.classList.add("done");
            row.state.textContent = "上传完成";
            resolve(undefined);
          } else {
            row.li.classList.add("error");
            row.state.textContent = "上传失败";
            reject(new Error("upload failed"));
          }
        };

        xhr.onerror = () => {
          row.li.classList.add("error");
          row.state.textContent = "上传失败";
          reject(new Error("upload failed"));
        };

        const fd = new FormData();
        fd.append("file", file, file.name);
        xhr.send(fd);
      });
    }

    async function uploadFiles(fileListLike) {
      const files = Array.from(fileListLike || []);
      if (!files.length || uploading) return;
      uploading = true;
      setMessage("上传中，请稍候...", "");
      pickBtn.disabled = true;
      uploadQueue.innerHTML = "";

      try {
        let success = 0;
        for (const file of files) {
          const row = createUploadRow(file);
          try {
            await uploadSingleFile(file, row);
            success += 1;
          } catch {
            // keep row as failed
          }
        }
        if (success === files.length) {
          setMessage("上传成功，已保存 " + success + " 个文件", "success");
        } else {
          setMessage("上传完成，成功 " + success + " / " + files.length, success > 0 ? "success" : "error");
        }
        await loadFiles();
      } catch {
        setMessage("上传失败，请重试", "error");
      } finally {
        uploading = false;
        pickBtn.disabled = false;
      }
    }

    function onDropLike(event) {
      event.preventDefault();
      drop.classList.remove("dragging");
      const files = event.dataTransfer?.files;
      if (files && files.length) uploadFiles(files);
    }

    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    pickBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      if (fileInput.files?.length) {
        uploadFiles(fileInput.files);
        fileInput.value = "";
      }
    });

    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    });
    drop.addEventListener("dragenter", (e) => {
      e.preventDefault();
      drop.classList.add("dragging");
    });
    drop.addEventListener("dragleave", (e) => {
      if (!drop.contains(e.relatedTarget)) drop.classList.remove("dragging");
    });
    drop.addEventListener("drop", onDropLike);

    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      if (!drop.contains(e.target)) onDropLike(e);
    });

    searchInput.addEventListener("input", () => {
      currentQuery = searchInput.value || "";
      renderFilteredFiles();
    });
    sortSelect.addEventListener("change", () => {
      currentSort = sortSelect.value || "mtime_desc";
      renderFilteredFiles();
    });
    void loadFiles();
    window.setInterval(() => void loadFiles(), 2000);
  </script>
</body>
</html>"#,
    )
}

async fn upload_file(
    AxumState(state): AxumState<HttpState>,
    mut multipart: Multipart,
) -> Result<Json<UploadResult>, (StatusCode, String)> {
    let mut saved = 0usize;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("读取上传内容失败: {e}")))?
    {
        let file_name = field
            .file_name()
            .and_then(sanitize_filename)
            .ok_or_else(|| (StatusCode::BAD_REQUEST, "无效文件名".to_string()))?;

        let bytes = field
            .bytes()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("读取文件内容失败: {e}")))?;

        let path = state.shared_dir.join(file_name);
        tokio::fs::write(path, bytes)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("保存文件失败: {e}")))?;
        saved += 1;
    }

    Ok(Json(UploadResult { saved }))
}

async fn list_files(AxumState(state): AxumState<HttpState>) -> Result<Json<Vec<SharedFile>>, (StatusCode, String)> {
    let files = collect_shared_files_from_dir(&state.shared_dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(files))
}

#[tauri::command]
async fn list_shared_files(shared_dir: String) -> Result<Vec<LocalSharedFile>, String> {
    let path = PathBuf::from(shared_dir);
    if !path.exists() {
        return Err("共享目录不存在".to_string());
    }
    if !path.is_dir() {
        return Err("共享目录不是文件夹".to_string());
    }
    collect_local_shared_files_from_dir(&path).await
}

async fn collect_shared_files_from_dir(dir: &Path) -> Result<Vec<SharedFile>, String> {
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("读取目录失败: {e}"))?;

    let mut files = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("读取目录项失败: {e}"))?
    {
        let meta = entry
            .metadata()
            .await
            .map_err(|e| format!("读取文件信息失败: {e}"))?;

        if !meta.is_file() {
            continue;
        }

        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "文件名编码不支持".to_string())?;
        if should_hide_from_shared_list(&name) {
            continue;
        }

        let modified_unix = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        files.push(SharedFile {
            name,
            size: meta.len(),
            modified_unix,
        });
    }

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

async fn collect_local_shared_files_from_dir(dir: &Path) -> Result<Vec<LocalSharedFile>, String> {
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|e| format!("读取目录失败: {e}"))?;

    let mut files = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("读取目录项失败: {e}"))?
    {
        let path = entry.path();
        let meta = entry
            .metadata()
            .await
            .map_err(|e| format!("读取文件信息失败: {e}"))?;

        if !meta.is_file() {
            continue;
        }

        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "文件名编码不支持".to_string())?;
        if should_hide_from_shared_list(&name) {
            continue;
        }

        let modified_unix = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        files.push(LocalSharedFile {
            name,
            size: meta.len(),
            modified_unix,
            path: path.to_string_lossy().to_string(),
        });
    }

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

#[tauri::command]
fn open_local_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("文件不存在".to_string());
    }
    if !target.is_file() {
        return Err("目标不是文件".to_string());
    }
    open_path_cross_platform(&target)
}

#[tauri::command]
fn open_file_location(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("文件不存在".to_string());
    }
    reveal_file_cross_platform(&target)
}

fn open_path_cross_platform(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .status()
            .map_err(|e| format!("打开文件失败: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("打开文件失败".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(path)
            .status()
            .map_err(|e| format!("打开文件失败: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("打开文件失败".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let status = Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|e| format!("打开文件失败: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("打开文件失败".to_string());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        Err("当前系统暂不支持打开文件".to_string())
    }
}

fn reveal_file_cross_platform(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .status()
            .map_err(|e| format!("打开目录失败: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("打开目录失败".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .args(["-R", &path.to_string_lossy()])
            .status()
            .map_err(|e| format!("打开目录失败: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("打开目录失败".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let dir = path
            .parent()
            .ok_or_else(|| "无法获取父目录".to_string())?;
        let status = Command::new("xdg-open")
            .arg(dir)
            .status()
            .map_err(|e| format!("打开目录失败: {e}"))?;
        if status.success() {
            return Ok(());
        }
        return Err("打开目录失败".to_string());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        Err("当前系统暂不支持打开目录".to_string())
    }
}

async fn download_file(
    AxumState(state): AxumState<HttpState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Response, (StatusCode, String)> {
    let safe_name = sanitize_filename(&name)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "无效文件名".to_string()))?;
    if should_hide_from_shared_list(&safe_name) {
        return Err((StatusCode::NOT_FOUND, "文件不存在".to_string()));
    }
    let path = state.shared_dir.join(&safe_name);

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "文件不存在".to_string()))?;

    let mut resp = (StatusCode::OK, bytes).into_response();
    let header_value = format!("attachment; filename=\"{}\"", safe_name.replace('"', "_"));

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        header::HeaderValue::from_str(&header_value)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("设置下载头失败: {e}")))?,
    );

    Ok(resp)
}

fn sanitize_filename(raw: &str) -> Option<String> {
    let clean = Path::new(raw).file_name()?.to_str()?.trim();
    if clean.is_empty() || clean == "." || clean == ".." {
        return None;
    }
    Some(clean.to_string())
}

fn should_hide_from_shared_list(name: &str) -> bool {
    name.starts_with('.')
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            pdf::images_to_pdf,
            start_file_server,
            stop_file_server,
            get_file_server_status,
            list_shared_files,
            open_local_file,
            open_file_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
