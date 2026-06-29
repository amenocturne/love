// --- Types ---

interface Entry {
  name: string
  kind: "dir" | "file"
  path: string
}

interface Column {
  path: string
  entries: Entry[]
  selectedRow: number
}

interface PlayingTrack {
  path: string
  name: string
  folderPath: string
  index: number
  totalFiles: number
}

interface TrackMetadata {
  artist: string | null
  title: string | null
  album: string | null
}

interface SearchResult {
  name: string
  path: string
}

interface AppState {
  columns: Column[]
  focusCol: number
  focusRow: number
  playing: PlayingTrack | null
  searchOpen: boolean
  searchResults: SearchResult[]
  searchSelectedIndex: number
}

// --- DOM refs ---

const $columns = document.getElementById("columns")!
const $coverArt = document.getElementById("cover-art") as HTMLImageElement
const $coverPlaceholder = document.getElementById("cover-placeholder")!
const $trackTitle = document.getElementById("track-title")!
const $trackArtist = document.getElementById("track-artist")!
const $seekContainer = document.getElementById("seek-container")!
const $seekProgress = document.getElementById("seek-progress")!
const $timeElapsed = document.getElementById("time-elapsed")!
const $trackPosition = document.getElementById("track-position")!
const $timeDuration = document.getElementById("time-duration")!
const $btnPrev = document.getElementById("btn-prev")!
const $btnPlay = document.getElementById("btn-play")!
const $btnNext = document.getElementById("btn-next")!
const $volume = document.getElementById("volume") as HTMLInputElement
const $volumeDisplay = document.getElementById("volume-display")!
const $audio = document.getElementById("audio") as HTMLAudioElement
const $toast = document.getElementById("toast")!
const $searchOverlay = document.getElementById("search-overlay")!
const $searchInput = document.getElementById("search-input") as HTMLInputElement
const $searchResults = document.getElementById("search-results")!

// --- State ---

const state: AppState = {
  columns: [],
  focusCol: 0,
  focusRow: 0,
  playing: null,
  searchOpen: false,
  searchResults: [],
  searchSelectedIndex: 0,
}

// --- API + Cache ---

const browseCache = new Map<string, Entry[]>()

async function loadTree() {
  const res = await fetch("/api/tree")
  if (!res.ok) return
  const tree: Record<string, Entry[]> = await res.json()
  for (const [path, entries] of Object.entries(tree)) {
    browseCache.set(path, entries)
  }
}

function fetchEntries(path: string): Entry[] {
  return browseCache.get(path) || []
}

async function fetchMetadata(path: string): Promise<TrackMetadata> {
  const res = await fetch(`/api/metadata/${encodePath(path)}`)
  if (!res.ok) return { artist: null, title: null, album: null }
  return res.json()
}

async function fetchSearch(query: string): Promise<SearchResult[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.results
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

function streamUrl(path: string): string {
  return `/api/stream/${encodePath(path)}`
}

function coverUrl(path: string): string {
  return `/api/cover/${encodePath(path)}`
}

// --- Formatting ---

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00"
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

function sliderToDb(pos: number): number {
  if (pos <= 0) return -Infinity
  return -60 * Math.pow((100 - pos) / 100, 1.5)
}

// --- Debounce ---

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: any[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as unknown as T
}

// --- Rendering ---

function maxVisibleColumns(): number {
  const colWidth = 220
  const panelWidth = $columns.clientWidth
  return Math.max(1, Math.floor(panelWidth / colWidth))
}

function renderColumns() {
  const maxCols = maxVisibleColumns()
  const startIdx = Math.max(0, state.columns.length - maxCols)

  $columns.innerHTML = ""

  for (let ci = startIdx; ci < state.columns.length; ci++) {
    const col = state.columns[ci]
    const colEl = document.createElement("div")
    colEl.className = "column"
    if (ci !== state.focusCol) colEl.classList.add("inactive")

    const childPath = ci + 1 < state.columns.length ? state.columns[ci + 1].path : null

    for (let ri = 0; ri < col.entries.length; ri++) {
      const entry = col.entries[ri]
      const row = document.createElement("div")
      row.className = "row"

      if (ci === state.focusCol && ri === state.focusRow) {
        row.classList.add("selected")
      }

      if (childPath && entry.path === childPath) {
        row.classList.add("expanded")
      }

      if (state.playing && entry.kind === "file" && entry.path === state.playing.path) {
        row.classList.add("playing")
      }

      const icon = document.createElement("span")
      icon.className = "row-icon"
      icon.textContent = entry.kind === "file" ? "♪" : ""

      const name = document.createElement("span")
      name.className = "row-name"
      name.textContent = entry.name

      row.appendChild(icon)
      row.appendChild(name)

      if (entry.kind === "dir") {
        const chevron = document.createElement("span")
        chevron.className = "row-chevron"
        chevron.textContent = "▸"
        row.appendChild(chevron)
      }

      row.addEventListener("click", () => onRowClick(ci, ri))
      colEl.appendChild(row)
    }

    $columns.appendChild(colEl)
  }

  scrollSelectedIntoView()
}

function scrollSelectedIntoView() {
  const selected = $columns.querySelector(".row.selected")
  if (selected) {
    selected.scrollIntoView({ block: "nearest" })
  }
}

function updatePlayerUI() {
  const p = state.playing
  if (p) {
    $trackPosition.textContent = `${p.index + 1} / ${p.totalFiles}`
  } else {
    $trackPosition.textContent = "—"
  }
  $btnPlay.textContent = $audio.paused ? "▶" : "⏸"
}

function updateCoverArt(trackPath: string | null) {
  if (trackPath) {
    $coverArt.src = coverUrl(trackPath)
    $coverArt.onload = () => {
      $coverArt.classList.add("visible")
      $coverPlaceholder.classList.add("hidden")
    }
    $coverArt.onerror = () => {
      $coverArt.classList.remove("visible")
      $coverPlaceholder.classList.remove("hidden")
    }
  } else {
    $coverArt.classList.remove("visible")
    $coverArt.src = ""
    $coverPlaceholder.classList.remove("hidden")
  }
}

async function updateTrackInfo(trackPath: string, fileName: string) {
  const meta = await fetchMetadata(trackPath)
  const title = meta.title || fileName.replace(/\.\w+$/, "")
  $trackTitle.textContent = title
  $trackArtist.textContent = meta.artist || ""

  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: meta.artist || "",
      album: meta.album || "",
      artwork: [{ src: coverUrl(trackPath) }],
    })
  }
}

// --- Navigation ---

function enterDirectory(colIndex: number, rowIndex: number) {
  const col = state.columns[colIndex]
  if (!col) return
  const entry = col.entries[rowIndex]
  if (!entry || entry.kind !== "dir") return

  col.selectedRow = rowIndex
  state.columns = state.columns.slice(0, colIndex + 1)
  const entries = fetchEntries(entry.path)
  state.columns.push({ path: entry.path, entries, selectedRow: 0 })
  state.focusCol = state.columns.length - 1
  state.focusRow = 0
  renderColumns()
}

function playFile(colIndex: number, rowIndex: number) {
  const col = state.columns[colIndex]
  if (!col) return
  const entry = col.entries[rowIndex]
  if (!entry || entry.kind !== "file") return

  const files = col.entries.filter(e => e.kind === "file")
  const fileIndex = files.findIndex(f => f.path === entry.path)

  state.playing = {
    path: entry.path,
    name: entry.name,
    folderPath: col.path,
    index: fileIndex,
    totalFiles: files.length,
  }

  $audio.src = streamUrl(entry.path)
  $audio.play()
  updateCoverArt(entry.path)
  updateTrackInfo(entry.path, entry.name)
  updatePlayerUI()
  renderColumns()
}

function playByFileIndex(delta: number) {
  if (!state.playing) return

  const folderCol = state.columns.find(c => c.path === state.playing!.folderPath)
  if (!folderCol) return

  const files = folderCol.entries.filter(e => e.kind === "file")
  const newIndex = state.playing.index + delta
  if (newIndex < 0 || newIndex >= files.length) return

  const file = files[newIndex]
  state.playing = {
    path: file.path,
    name: file.name,
    folderPath: state.playing.folderPath,
    index: newIndex,
    totalFiles: files.length,
  }

  const colIdx = state.columns.indexOf(folderCol)
  if (colIdx >= 0) {
    const rowIdx = folderCol.entries.indexOf(file)
    if (rowIdx >= 0) {
      state.focusCol = colIdx
      state.focusRow = rowIdx
      folderCol.selectedRow = rowIdx
    }
  }

  $audio.src = streamUrl(file.path)
  $audio.play()
  updateCoverArt(file.path)
  updateTrackInfo(file.path, file.name)
  updatePlayerUI()
  renderColumns()
}

// --- Search ---

const SEARCH_HISTORY_KEY = "love-search-history"
const MAX_SEARCH_HISTORY = 50
let searchHistory: string[] = []

function loadSearchHistory() {
  try {
    searchHistory = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]")
  } catch { searchHistory = [] }
}

function saveSearchHistory() {
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(searchHistory))
}

function addToSearchHistory(query: string) {
  const trimmed = query.trim()
  if (!trimmed) return
  searchHistory = [trimmed, ...searchHistory.filter(h => h !== trimmed)].slice(0, MAX_SEARCH_HISTORY)
  saveSearchHistory()
}

function openSearch() {
  state.searchOpen = true
  state.searchResults = []
  state.searchSelectedIndex = 0
  $searchOverlay.classList.remove("hidden")
  $searchInput.value = ""
  $searchInput.focus()
  showHistoryAsResults()
}

function closeSearch() {
  state.searchOpen = false
  $searchOverlay.classList.add("hidden")
  $searchInput.blur()
}

interface SearchDisplayItem {
  name: string
  path: string
  isHistory?: boolean
}

let searchDisplayItems: SearchDisplayItem[] = []

function showHistoryAsResults() {
  searchDisplayItems = searchHistory.map(q => ({ name: q, path: "", isHistory: true }))
  state.searchSelectedIndex = 0
  renderSearchDisplay()
}

function renderSearchDisplay() {
  $searchResults.innerHTML = ""
  for (let i = 0; i < searchDisplayItems.length; i++) {
    const item = searchDisplayItems[i]
    const el = document.createElement("div")
    el.className = "search-result"
    if (i === state.searchSelectedIndex) el.classList.add("selected")

    const nameEl = document.createElement("div")
    nameEl.className = "search-result-name"
    nameEl.textContent = item.name

    if (!item.isHistory) {
      const pathEl = document.createElement("div")
      pathEl.className = "search-result-path"
      pathEl.textContent = item.path
      el.appendChild(nameEl)
      el.appendChild(pathEl)
    } else {
      nameEl.classList.add("search-history-item")
      el.appendChild(nameEl)
      const del = document.createElement("span")
      del.className = "search-result-delete"
      del.textContent = "✕"
      del.addEventListener("click", (e) => {
        e.stopPropagation()
        searchHistory = searchHistory.filter(h => h !== item.name)
        saveSearchHistory()
        showHistoryAsResults()
      })
      el.appendChild(del)
    }

    el.addEventListener("click", () => selectSearchItem(i))
    $searchResults.appendChild(el)
  }

  const selected = $searchResults.querySelector(".search-result.selected")
  if (selected) selected.scrollIntoView({ block: "nearest" })
}

const doSearch = debounce(async () => {
  const query = $searchInput.value.trim()
  if (query.length < 2) {
    showHistoryAsResults()
    return
  }
  state.searchResults = await fetchSearch(query)
  searchDisplayItems = state.searchResults.map(r => ({ name: r.name, path: r.path }))
  state.searchSelectedIndex = 0
  renderSearchDisplay()
}, 200)

function onSearchManualInput() {
  doSearch()
}

async function selectSearchItem(index: number) {
  const item = searchDisplayItems[index]
  if (!item) return
  if (item.isHistory) {
    $searchInput.value = item.name
    doSearch()
    return
  }
  addToSearchHistory($searchInput.value.trim())
  closeSearch()
  navigateToPath(item.path)
}

function navigateToPath(fullPath: string, autoplay = true) {
  const segments = fullPath.split("/")

  const rootEntries = fetchEntries("")
  state.columns = [{ path: "", entries: rootEntries, selectedRow: 0 }]

  let lastFileIndex = -1

  for (let i = 0; i < segments.length; i++) {
    const col = state.columns[state.columns.length - 1]
    const entryIndex = col.entries.findIndex(e => e.name === segments[i])
    if (entryIndex < 0) break

    const entry = col.entries[entryIndex]
    col.selectedRow = entryIndex

    if (entry.kind === "dir") {
      const entries = fetchEntries(entry.path)
      state.columns.push({ path: entry.path, entries, selectedRow: 0 })
    } else {
      state.focusCol = state.columns.length - 1
      state.focusRow = entryIndex
      lastFileIndex = entryIndex
    }
  }

  if (state.focusCol === 0 && state.columns.length > 1) {
    state.focusCol = state.columns.length - 1
    state.focusRow = 0
  }

  renderColumns()

  if (lastFileIndex >= 0 && autoplay) {
    playFile(state.focusCol, lastFileIndex)
  } else if (lastFileIndex >= 0) {
    // Set up playing state without starting playback
    const col = state.columns[state.focusCol]
    const entry = col.entries[lastFileIndex]
    const files = col.entries.filter(e => e.kind === "file")
    const fileIndex = files.findIndex(f => f.path === entry.path)
    state.playing = {
      path: entry.path,
      name: entry.name,
      folderPath: col.path,
      index: fileIndex,
      totalFiles: files.length,
    }
    $audio.src = streamUrl(entry.path)
    updateCoverArt(entry.path)
    updateTrackInfo(entry.path, entry.name)
    updatePlayerUI()
    renderColumns()
  }
}

function onSearchKeyDown(e: KeyboardEvent) {
  switch (e.key) {
    case "Escape":
      e.preventDefault()
      closeSearch()
      break
    case "ArrowDown":
    case "Tab":
      e.preventDefault()
      if (state.searchSelectedIndex < searchDisplayItems.length - 1) {
        state.searchSelectedIndex++
        renderSearchDisplay()
      }
      break
    case "ArrowUp":
      e.preventDefault()
      if (state.searchSelectedIndex > 0) {
        state.searchSelectedIndex--
        renderSearchDisplay()
      }
      break
    case "Enter":
      e.preventDefault()
      selectSearchItem(state.searchSelectedIndex)
      break
  }
}

function onCoverClick() {
  if (!state.playing) return
  const segments = state.playing.path.split("/")

  const rootEntries = fetchEntries("")
  state.columns = [{ path: "", entries: rootEntries, selectedRow: 0 }]

  for (let i = 0; i < segments.length; i++) {
    const col = state.columns[state.columns.length - 1]
    const entryIndex = col.entries.findIndex(e => e.name === segments[i])
    if (entryIndex < 0) break
    const entry = col.entries[entryIndex]
    col.selectedRow = entryIndex
    if (entry.kind === "dir") {
      const entries = fetchEntries(entry.path)
      state.columns.push({ path: entry.path, entries, selectedRow: 0 })
    } else {
      state.focusCol = state.columns.length - 1
      state.focusRow = entryIndex
    }
  }
  renderColumns()
}

// --- Event handlers ---

function onRowClick(colIndex: number, rowIndex: number) {
  state.columns[colIndex].selectedRow = rowIndex
  state.focusCol = colIndex
  state.focusRow = rowIndex

  state.columns = state.columns.slice(0, colIndex + 1)

  const entry = state.columns[colIndex].entries[rowIndex]
  if (entry.kind === "dir") {
    enterDirectory(colIndex, rowIndex)
  } else {
    playFile(colIndex, rowIndex)
    renderColumns()
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (state.searchOpen) {
    onSearchKeyDown(e)
    return
  }

  const col = state.columns[state.focusCol]
  if (!col) return

  switch (e.key) {
    case "/":
      e.preventDefault()
      openSearch()
      break

    case "j":
    case "ArrowDown":
      e.preventDefault()
      if (state.focusRow < col.entries.length - 1) {
        state.focusRow++
        col.selectedRow = state.focusRow
        renderColumns()
      }
      break

    case "k":
    case "ArrowUp":
      e.preventDefault()
      if (state.focusRow > 0) {
        state.focusRow--
        col.selectedRow = state.focusRow
        renderColumns()
      }
      break

    case "l":
    case "ArrowRight":
    case "Enter": {
      e.preventDefault()
      const entry = col.entries[state.focusRow]
      if (!entry) break
      if (entry.kind === "dir") {
        enterDirectory(state.focusCol, state.focusRow)
      } else {
        playFile(state.focusCol, state.focusRow)
      }
      break
    }

    case "h":
    case "ArrowLeft":
      e.preventDefault()
      if (state.focusCol > 0) {
        state.columns = state.columns.slice(0, state.focusCol)
        state.focusCol--
        state.focusRow = state.columns[state.focusCol].selectedRow
        renderColumns()
      }
      break

    case " ":
      e.preventDefault()
      if ($audio.src) {
        if ($audio.paused) $audio.play()
        else $audio.pause()
        updatePlayerUI()
      }
      break

    case "Escape":
      e.preventDefault()
      handleEscape()
      break
  }
}

function onSeekClick(e: MouseEvent) {
  if (!$audio.duration) return
  const rect = $seekContainer.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  $audio.currentTime = ratio * $audio.duration
}

let lastSaveTime = 0
let prefetchedPath = ""

function onTimeUpdate() {
  if (!$audio.duration) return
  const pct = ($audio.currentTime / $audio.duration) * 100
  $seekProgress.style.width = `${pct}%`
  $timeElapsed.textContent = formatTime($audio.currentTime)
  $timeDuration.textContent = formatTime($audio.duration)

  const now = Date.now()
  if (now - lastSaveTime > 3000) {
    lastSaveTime = now
    saveState()
  }

  const remaining = $audio.duration - $audio.currentTime
  if (remaining < 10 && remaining > 0 && state.playing) {
    prefetchNextTrack()
  }
}

function prefetchNextTrack() {
  if (!state.playing) return
  const folderCol = state.columns.find(c => c.path === state.playing!.folderPath)
  if (!folderCol) return
  const files = folderCol.entries.filter(e => e.kind === "file")
  const nextIndex = state.playing.index + 1
  if (nextIndex >= files.length) return
  const nextPath = files[nextIndex].path
  if (prefetchedPath === nextPath) return
  prefetchedPath = nextPath
  fetch(streamUrl(nextPath), { method: "HEAD" })
}

function onTrackEnded() {
  playByFileIndex(1)
}

function onVolumeChange() {
  const pos = parseFloat($volume.value)
  const db = sliderToDb(pos)
  if (db <= -60) {
    $audio.volume = 0
    $volumeDisplay.textContent = "-∞ dB"
  } else {
    $audio.volume = Math.pow(10, db / 20)
    $volumeDisplay.textContent = `${db.toFixed(1)} dB`
  }
}

// --- Toast ---

let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(msg: string, ms = 2000) {
  $toast.textContent = msg
  $toast.classList.remove("hidden")
  requestAnimationFrame(() => $toast.classList.add("visible"))
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    $toast.classList.remove("visible")
    setTimeout(() => $toast.classList.add("hidden"), 200)
  }, ms)
}

// --- Stop / Reset ---

let escPending = false
let escTimer: ReturnType<typeof setTimeout> | null = null

function handleEscape() {
  if (state.searchOpen) {
    closeSearch()
    return
  }
  if (!state.playing) return

  if (escPending) {
    escPending = false
    if (escTimer) clearTimeout(escTimer)
    stopAndReset()
  } else {
    escPending = true
    showToast("Press Esc again to stop", 2000)
    escTimer = setTimeout(() => { escPending = false }, 2000)
  }
}

function stopAndReset() {
  $audio.pause()
  $audio.removeAttribute("src")
  $audio.load()
  state.playing = null
  prefetchedPath = ""
  $coverArt.classList.remove("visible")
  $coverArt.src = ""
  $coverPlaceholder.classList.remove("hidden")
  $trackTitle.textContent = ""
  $trackArtist.textContent = ""
  $seekProgress.style.width = "0%"
  $timeElapsed.textContent = "0:00"
  $timeDuration.textContent = "0:00"
  $trackPosition.textContent = "—"
  updatePlayerUI()
  renderColumns()
  localStorage.removeItem("love-state")
}

// --- Persistence ---

function saveState() {
  if (!state.playing) return
  const data = {
    path: state.playing.path,
    name: state.playing.name,
    currentTime: $audio.currentTime,
    volume: parseFloat($volume.value),
  }
  localStorage.setItem("love-state", JSON.stringify(data))
}

async function restoreState() {
  const raw = localStorage.getItem("love-state")
  if (!raw) return
  try {
    const data = JSON.parse(raw)
    if (data.volume !== undefined) {
      $volume.value = String(data.volume)
      onVolumeChange()
    }
    if (data.path) {
      navigateToPath(data.path, false)
      $audio.currentTime = data.currentTime || 0
      $audio.pause()
      updatePlayerUI()
    }
  } catch {}
}

// --- MediaSession ---

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return
  navigator.mediaSession.setActionHandler("play", () => { $audio.play(); updatePlayerUI() })
  navigator.mediaSession.setActionHandler("pause", () => { $audio.pause(); updatePlayerUI() })
  navigator.mediaSession.setActionHandler("previoustrack", () => playByFileIndex(-1))
  navigator.mediaSession.setActionHandler("nexttrack", () => playByFileIndex(1))
}

// --- Init ---

async function init() {
  await loadTree()
  state.columns = [{ path: "", entries: fetchEntries(""), selectedRow: 0 }]
  state.focusCol = 0
  state.focusRow = 0
  renderColumns()

  document.addEventListener("keydown", onKeyDown)
  $seekContainer.addEventListener("click", onSeekClick)
  $audio.addEventListener("timeupdate", onTimeUpdate)
  $audio.addEventListener("ended", onTrackEnded)
  $audio.addEventListener("play", updatePlayerUI)
  $audio.addEventListener("pause", updatePlayerUI)
  $btnPrev.addEventListener("click", () => playByFileIndex(-1))
  $btnPlay.addEventListener("click", () => {
    if ($audio.src) {
      if ($audio.paused) $audio.play()
      else $audio.pause()
    }
  })
  $btnNext.addEventListener("click", () => playByFileIndex(1))
  $volume.addEventListener("input", onVolumeChange)
  $searchInput.addEventListener("input", onSearchManualInput)
  $searchOverlay.addEventListener("click", (e) => {
    if (e.target === $searchOverlay) closeSearch()
  })
  onVolumeChange()

  $coverArt.addEventListener("click", onCoverClick)
  $coverPlaceholder.addEventListener("click", onCoverClick)
  window.addEventListener("resize", renderColumns)
  window.addEventListener("beforeunload", saveState)
  setupMediaSession()
  loadSearchHistory()
  await restoreState()
}

init()
