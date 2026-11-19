declare const __LOVE_BUILD__: string

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
  scrollTop?: number
}

type PlaybackSource = { kind: "folder"; path: string } | { kind: "list"; key: string }

interface PlayingTrack {
  path: string
  source: PlaybackSource
  files: Entry[]
  index: number
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

interface BrowserState {
  kind: "folders" | "lists"
  columns: Column[]
  focusCol: number
  focusRow: number
}

interface AppState {
  playing: PlayingTrack | null
  searchOpen: boolean
  searchResults: SearchResult[]
  searchSelectedIndex: number
}

// --- DOM refs ---

const $columns = document.getElementById("columns")!
const $browserTitle = document.getElementById("browser-title")!
const $btnClearList = document.getElementById("btn-clear-list") as HTMLButtonElement
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
const $btnDownload = document.getElementById("btn-download") as HTMLButtonElement
const $volume = document.getElementById("volume") as HTMLInputElement
const $volumeDisplay = document.getElementById("volume-display")!
const $audio = document.getElementById("audio") as HTMLAudioElement
const $toast = document.getElementById("toast")!
const $searchOverlay = document.getElementById("search-overlay")!
const $searchInput = document.getElementById("search-input") as HTMLInputElement
const $searchResults = document.getElementById("search-results")!

// --- State ---

const folderBrowser: BrowserState = { kind: "folders", columns: [], focusCol: 0, focusRow: 0 }
const listBrowser: BrowserState = { kind: "lists", columns: [], focusCol: 0, focusRow: 0 }
let browser = folderBrowser

const state: AppState = {
  playing: null,
  searchOpen: false,
  searchResults: [],
  searchSelectedIndex: 0,
}

const listKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
const listColors = ["#ff6663", "#ffa552", "#ffdb58", "#65d97a", "#4ab0fa", "#d95cf6", "#acadb3", "#44c9c4", "#ff81ad", "#b8a173"]
const listsStorageKey = "love-quick-lists"
const quickLists = new Map<string, string[]>()
const renderedColumns = new Map<Column, HTMLElement>()

// --- API + Cache ---

const browseCache = new Map<string, Entry[]>()
const audioCache = new Map<string, string>()
let warmingFolder = ""
let warmController: AbortController | null = null

let treeEtag: string | null = null
let treeRequestInFlight = false

async function loadTree(): Promise<boolean> {
  if (treeRequestInFlight) return false
  treeRequestInFlight = true
  try {
    const headers: Record<string, string> = {}
    if (treeEtag) headers["If-None-Match"] = treeEtag
    const res = await fetch("/api/tree", { headers, cache: "no-cache" })
    if (res.status === 304 || !res.ok) return false
    const tree: Record<string, Entry[]> = await res.json()
    browseCache.clear()
    for (const [path, entries] of Object.entries(tree)) {
      browseCache.set(path, entries)
    }
    treeEtag = res.headers.get("ETag")
    return true
  } catch {
    // Keep the last complete tree while the server is temporarily unavailable.
    return false
  } finally {
    treeRequestInFlight = false
  }
}

function refreshFolderBrowser() {
  const columns: Column[] = []
  for (const previous of folderBrowser.columns) {
    if (!browseCache.has(previous.path)) break
    if (columns.length > 0 && !columns[columns.length - 1].entries.some(
      entry => entry.kind === "dir" && entry.path === previous.path,
    )) break
    const entries = fetchEntries(previous.path)
    columns.push(refreshColumn(previous, entries))
  }
  folderBrowser.columns = columns.length > 0 ? columns : [{ path: "", entries: fetchEntries(""), selectedRow: 0 }]
  folderBrowser.focusCol = Math.min(folderBrowser.focusCol, folderBrowser.columns.length - 1)
  folderBrowser.focusRow = folderBrowser.columns[folderBrowser.focusCol].selectedRow

  const playing = state.playing
  if (playing?.source.kind === "folder") {
    const files = fetchEntries(playing.source.path).filter(entry => entry.kind === "file")
    const index = files.findIndex(entry => entry.path === playing.path)
    if (index >= 0) {
      state.playing = { ...playing, files, index }
      updatePlayerUI()
    }
  }
}

async function refreshLibrary() {
  if (document.hidden || !await loadTree()) return
  rememberColumnScroll()
  refreshFolderBrowser()
  refreshListBrowser()
  renderColumns()
  if (state.searchOpen && $searchInput.value.trim().length >= 2) doSearch()
}

function fetchEntries(path: string): Entry[] {
  return browseCache.get(path) || []
}

function trackAtPath(path: string): Entry | undefined {
  const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")))
  return fetchEntries(parent).find(entry => entry.kind === "file" && entry.path === path)
}

function refreshColumn(column: Column, entries: Entry[]): Column {
  const selectedPath = column.entries[column.selectedRow]?.path
  const row = entries.findIndex(entry => entry.path === selectedPath)
  return { ...column, entries, selectedRow: row >= 0 ? row : Math.max(0, Math.min(column.selectedRow, entries.length - 1)) }
}

// --- Quick lists ---

function loadLists() {
  try {
    const saved = JSON.parse(localStorage.getItem(listsStorageKey) || "{}")
    for (const key of listKeys) {
      if (Array.isArray(saved?.[key])) {
        quickLists.set(key, [...new Set<string>(saved[key].filter((path: unknown) => typeof path === "string"))])
      }
    }
  } catch {}
}

function saveLists() {
  localStorage.setItem(listsStorageKey, JSON.stringify(Object.fromEntries(quickLists)))
}

function listTracks(key: string): Entry[] {
  return (quickLists.get(key) || []).flatMap(path => trackAtPath(path) ?? [])
}

function refreshListBrowser() {
  const slots: Entry[] = listKeys.map(key => ({
    name: key,
    kind: "dir",
    path: key,
  }))
  if (!listBrowser.columns.length) {
    listBrowser.columns = [{ path: "", entries: slots, selectedRow: 0 }]
  }
  const list = listBrowser.columns[1]
  if (list) listBrowser.columns[1] = refreshColumn(list, listTracks(list.path))
  listBrowser.focusRow = listBrowser.columns[listBrowser.focusCol].selectedRow
}

function toggleListMembership(key: string, track: Entry) {
  const paths = quickLists.get(key) || []
  quickLists.set(key, paths.includes(track.path) ? paths.filter(path => path !== track.path) : [...paths, track.path])
  saveLists()
  rememberColumnScroll()
  refreshListBrowser()
  renderColumns()
}

function currentListKey() {
  return listBrowser.columns[1]?.path || listBrowser.columns[0]?.entries[listBrowser.focusRow]?.path
}

function clearCurrentList() {
  const key = currentListKey()
  if (!key || browser !== listBrowser) return
  quickLists.delete(key)
  saveLists()
  rememberColumnScroll()
  refreshListBrowser()
  renderColumns()
  $columns.focus({ preventScroll: true })
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

function clearAudioCache() {
  for (const url of audioCache.values()) URL.revokeObjectURL(url)
  audioCache.clear()
  warmingFolder = ""
}

async function warmFolder(folderPath: string) {
  if (warmingFolder === folderPath) return

  if (warmController) warmController.abort()
  clearAudioCache()

  warmingFolder = folderPath
  warmController = new AbortController()
  const signal = warmController.signal

  try {
    await fetch(`/api/warm?path=${encodeURIComponent(folderPath)}`, { method: "POST", signal })
  } catch { return }

  const entries = browseCache.get(folderPath) || []
  const files = entries.filter(e => e.kind === "file")

  await Promise.all(files.map(async (file) => {
    if (signal.aborted || audioCache.has(file.path)) return
    try {
      const res = await fetch(streamUrl(file.path), { signal })
      if (!res.ok) return
      const blob = await res.blob()
      if (signal.aborted) return
      audioCache.set(file.path, URL.createObjectURL(blob))
    } catch {}
  }))
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

function selectedTrack(): Entry | null {
  const entry = browser.columns[browser.focusCol]?.entries[browser.focusRow]
  return entry?.kind === "file" ? entry : null
}

function downloadSelectedTrack() {
  const track = selectedTrack()
  if (!track) return
  const link = document.createElement("a")
  link.href = `/api/download/${encodePath(track.path)}`
  link.download = track.name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function rememberColumnScroll() {
  for (const [column, element] of renderedColumns) column.scrollTop = element.scrollTop
}

function listDot(key: string) {
  const dot = document.createElement("span")
  dot.className = "list-dot"
  dot.style.backgroundColor = listColors[listKeys.indexOf(key)]
  dot.title = `List ${key}`
  return dot
}

function renderColumns(revealSelection = false) {
  rememberColumnScroll()
  renderedColumns.clear()
  const track = selectedTrack()
  $btnDownload.disabled = track === null
  $btnDownload.title = track ? `Download original: ${track.name}` : "Select a track to download"
  const inLists = browser === listBrowser
  $browserTitle.textContent = inLists ? "Lists" : "Folders"
  $btnClearList.hidden = !inLists
  const listKey = inLists ? currentListKey() : undefined
  $btnClearList.disabled = !listKey || !quickLists.get(listKey)?.length
  $btnClearList.title = listKey ? `Clear list ${listKey}` : "Clear list"
  const maxCols = maxVisibleColumns()
  const startIdx = Math.max(0, browser.columns.length - maxCols)

  $columns.innerHTML = ""

  for (let ci = startIdx; ci < browser.columns.length; ci++) {
    const col = browser.columns[ci]
    const colEl = document.createElement("div")
    colEl.className = "column"
    if (ci !== browser.focusCol) colEl.classList.add("inactive")

    const childPath = ci + 1 < browser.columns.length ? browser.columns[ci + 1].path : null

    for (let ri = 0; ri < col.entries.length; ri++) {
      const entry = col.entries[ri]
      const row = document.createElement("div")
      row.className = "row"

      if (ci === browser.focusCol && ri === browser.focusRow) {
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

      if (inLists && entry.kind === "dir") {
        icon.appendChild(listDot(entry.path))
      }
      row.appendChild(icon)
      row.appendChild(name)

      if (entry.kind === "dir") {
        if (inLists) {
          const count = document.createElement("span")
          count.className = "list-count"
          count.textContent = String(listTracks(entry.path).length)
          row.appendChild(count)
        }
        const chevron = document.createElement("span")
        chevron.className = "row-chevron"
        chevron.textContent = "▸"
        row.appendChild(chevron)
      } else {
        for (const key of listKeys) {
          if (quickLists.get(key)?.includes(entry.path)) row.appendChild(listDot(key))
        }
      }

      row.addEventListener("click", () => onRowClick(ci, ri))
      colEl.appendChild(row)
    }

    $columns.appendChild(colEl)
    colEl.scrollTop = col.scrollTop || 0
    renderedColumns.set(col, colEl)
  }

  if (revealSelection) scrollSelectedIntoView()
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
    $trackPosition.textContent = `${p.index + 1} / ${p.files.length}`
  } else {
    $trackPosition.textContent = "—"
  }
  $btnPlay.textContent = $audio.paused ? "▶" : "⏸"
}

function requestPlayback() {
  $audio.play().catch(error => {
    if (error.name !== "AbortError") showToast("Unable to play this track")
  })
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
  if (state.playing?.path !== trackPath) return
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
  const col = browser.columns[colIndex]
  if (!col) return
  const entry = col.entries[rowIndex]
  if (!entry || entry.kind !== "dir") return

  col.selectedRow = rowIndex
  browser.columns = browser.columns.slice(0, colIndex + 1)
  const entries = browser === listBrowser ? listTracks(entry.path) : fetchEntries(entry.path)
  browser.columns.push({ path: entry.path, entries, selectedRow: 0 })
  browser.focusCol = browser.columns.length - 1
  browser.focusRow = 0
  renderColumns(true)
}

function playFile(colIndex: number, rowIndex: number) {
  const col = browser.columns[colIndex]
  if (!col) return
  const entry = col.entries[rowIndex]
  if (!entry || entry.kind !== "file") return

  const files = col.entries.filter(e => e.kind === "file")
  const fileIndex = files.findIndex(f => f.path === entry.path)

  const source: PlaybackSource = browser === listBrowser
    ? { kind: "list", key: col.path }
    : { kind: "folder", path: col.path }
  startTrack(source, files, fileIndex)
}

function startTrack(source: PlaybackSource, files: Entry[], index: number, autoplay = true) {
  const file = files[index]
  if (!file) return
  state.playing = {
    path: file.path,
    source,
    files,
    index,
  }

  $audio.src = audioCache.get(file.path) || streamUrl(file.path)
  if (autoplay) requestPlayback()
  updateCoverArt(file.path)
  updateTrackInfo(file.path, file.name)
  updatePlayerUI()
  renderColumns()
  if (source.kind === "folder") warmFolder(source.path)
}

function playByFileIndex(delta: number) {
  const playing = state.playing
  if (!playing) return
  const { source, files } = playing
  const index = playing.index + delta
  const file = files[index]
  if (!file) return

  const focusColumn = browser.columns[browser.focusCol]
  const followsQueue = source.kind === "folder"
    ? browser === folderBrowser && focusColumn?.path === source.path
    : browser === listBrowser && focusColumn?.path === source.key
  if (followsQueue && selectedTrack()?.path === playing.path) {
    const row = focusColumn.entries.findIndex(entry => entry.path === file.path)
    if (row >= 0) {
      browser.focusRow = row
      focusColumn.selectedRow = row
    }
  }
  startTrack(source, files, index)
  if (followsQueue && selectedTrack()?.path === file.path) scrollSelectedIntoView()
}

function switchBrowser() {
  browser = browser === folderBrowser ? listBrowser : folderBrowser
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

function showTrackFolder(path: string) {
  const segments = path.split("/")
  const columns: Column[] = [{ path: "", entries: fetchEntries(""), selectedRow: 0 }]
  for (const segment of segments) {
    const col = columns[columns.length - 1]
    const entryIndex = col.entries.findIndex(e => e.name === segment)
    if (entryIndex < 0) break

    const entry = col.entries[entryIndex]
    col.selectedRow = entryIndex

    if (entry.kind === "dir") {
      columns.push({ path: entry.path, entries: fetchEntries(entry.path), selectedRow: 0 })
    }
  }

  folderBrowser.columns = columns
  folderBrowser.focusCol = columns.length - 1
  folderBrowser.focusRow = columns[folderBrowser.focusCol].selectedRow
  browser = folderBrowser
  renderColumns(true)
}

function navigateToPath(path: string) {
  if (!trackAtPath(path)) return
  showTrackFolder(path)
  playFile(browser.focusCol, browser.focusRow)
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
  if (state.playing) showTrackFolder(state.playing.path)
}

// --- Event handlers ---

function onRowClick(colIndex: number, rowIndex: number) {
  $columns.focus({ preventScroll: true })
  browser.columns[colIndex].selectedRow = rowIndex
  browser.focusCol = colIndex
  browser.focusRow = rowIndex

  browser.columns = browser.columns.slice(0, colIndex + 1)

  const entry = browser.columns[colIndex].entries[rowIndex]
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

  const browsing = e.target === $columns || e.target === document.body
  const bareKey = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  if (browsing && bareKey && e.key === "Tab") {
    e.preventDefault()
    if (!e.repeat) switchBrowser()
    return
  }
  if (browsing && bareKey && listKeys.includes(e.key)) {
    e.preventDefault()
    const track = selectedTrack()
    if (track && !e.repeat) toggleListMembership(e.key, track)
    return
  }
  if (e.target instanceof HTMLElement && e.target.matches("button, input") && (e.key === "Enter" || e.key === " ")) return

  const col = browser.columns[browser.focusCol]
  if (!col) return

  switch (e.key) {
    case "/":
      e.preventDefault()
      openSearch()
      break

    case "j":
    case "ArrowDown":
      e.preventDefault()
      if (browser.focusRow < col.entries.length - 1) {
        browser.focusRow++
        col.selectedRow = browser.focusRow
        renderColumns(true)
      }
      break

    case "k":
    case "ArrowUp":
      e.preventDefault()
      if (browser.focusRow > 0) {
        browser.focusRow--
        col.selectedRow = browser.focusRow
        renderColumns(true)
      }
      break

    case "l":
    case "ArrowRight":
    case "Enter": {
      e.preventDefault()
      const entry = col.entries[browser.focusRow]
      if (!entry) break
      if (entry.kind === "dir") {
        enterDirectory(browser.focusCol, browser.focusRow)
      } else {
        playFile(browser.focusCol, browser.focusRow)
      }
      break
    }

    case "h":
    case "ArrowLeft":
      e.preventDefault()
      if (browser.focusCol > 0) {
        browser.columns = browser.columns.slice(0, browser.focusCol)
        browser.focusCol--
        browser.focusRow = browser.columns[browser.focusCol].selectedRow
        renderColumns(true)
      }
      break

    case " ":
      e.preventDefault()
      if ($audio.src) {
        if ($audio.paused) requestPlayback()
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
  const playing = state.playing
  if (!playing) return
  const nextPath = playing.files[playing.index + 1]?.path
  if (!nextPath) return
  if (audioCache.has(nextPath)) return
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
  clearAudioCache()
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
    currentTime: $audio.currentTime,
    volume: parseFloat($volume.value),
    ...(state.playing.source.kind === "list" && {
      list: state.playing.source.key,
      queue: state.playing.files.map(file => file.path),
    }),
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
    if (typeof data.path === "string" && trackAtPath(data.path)) {
      if (listKeys.includes(data.list) && Array.isArray(data.queue)) {
        const files = data.queue.flatMap((path: unknown) => typeof path === "string" ? trackAtPath(path) ?? [] : [])
        const index = files.findIndex((file: Entry) => file.path === data.path)
        if (index >= 0) startTrack({ kind: "list", key: data.list }, files, index, false)
      }
      if (!state.playing) {
        showTrackFolder(data.path)
        const col = folderBrowser.columns[folderBrowser.focusCol]
        const files = col.entries.filter(entry => entry.kind === "file")
        const index = files.findIndex(entry => entry.path === data.path)
        startTrack({ kind: "folder", path: col.path }, files, index, false)
      }
      $audio.currentTime = data.currentTime || 0
      $audio.pause()
      updatePlayerUI()
    }
  } catch {}
}

// --- MediaSession ---

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return
  navigator.mediaSession.setActionHandler("play", () => { requestPlayback(); updatePlayerUI() })
  navigator.mediaSession.setActionHandler("pause", () => { $audio.pause(); updatePlayerUI() })
  navigator.mediaSession.setActionHandler("previoustrack", () => playByFileIndex(-1))
  navigator.mediaSession.setActionHandler("nexttrack", () => playByFileIndex(1))
}

// --- Init ---

async function init() {
  await loadTree()
  browser.columns = [{ path: "", entries: fetchEntries(""), selectedRow: 0 }]
  browser.focusCol = 0
  browser.focusRow = 0
  loadLists()
  refreshListBrowser()
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
      if ($audio.paused) requestPlayback()
      else $audio.pause()
    }
  })
  $btnNext.addEventListener("click", () => playByFileIndex(1))
  $btnDownload.addEventListener("click", downloadSelectedTrack)
  $btnClearList.addEventListener("click", clearCurrentList)
  $volume.addEventListener("input", onVolumeChange)
  $searchInput.addEventListener("input", onSearchManualInput)
  $searchOverlay.addEventListener("click", (e) => {
    if (e.target === $searchOverlay) closeSearch()
  })
  onVolumeChange()

  $coverArt.addEventListener("click", onCoverClick)
  $coverPlaceholder.addEventListener("click", onCoverClick)
  window.addEventListener("resize", () => renderColumns(true))
  window.addEventListener("beforeunload", saveState)
  setupMediaSession()
  loadSearchHistory()
  await restoreState()

  setInterval(refreshLibrary, 5000)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshLibrary()
  })

  document.getElementById("version")!.textContent = __LOVE_BUILD__
  fetch("/api/version", { cache: "no-store" }).then(r => {
    if (!r.ok) throw new Error("Version check failed")
    return r.json()
  }).then(v => {
    if (v.commit === __LOVE_BUILD__) return
    const warning = document.createElement("div")
    warning.id = "version-warning"
    warning.setAttribute("role", "alert")
    warning.textContent = "Love has been updated. Reload this page to load the current version."
    document.body.appendChild(warning)
  }).catch(() => {})
}

init()
