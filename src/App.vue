<template>
  <div class="app">
    <header class="bar">
      <div class="bar-left">
        <h1>Plan de table</h1>
        <span class="sep">·</span>
        <span class="counts">{{ placedCount }}/{{ totalSeats }} places</span>
        <span v-if="unassigned.length" class="counts muted">· {{ unassigned.length }} non placés</span>
        <span v-if="syncLabel" class="sync" :class="syncStatus">{{ syncLabel }}</span>
      </div>
      <div class="bar-right">
        <button type="button" class="link" @click="showAddTable = true">+ Table</button>
        <button type="button" class="link muted" @click="resetData">Reset</button>
      </div>
    </header>

    <p v-if="toast" class="toast">{{ toast }}</p>

    <section class="board">
      <article class="col bare">
        <header class="col-h">
          <span>Non placés</span>
          <span class="n">{{ unassigned.length }}</span>
        </header>
        <ul ref="unassignedList" class="list" data-table-id="unassigned">
          <li
            v-for="guest in unassigned"
            :key="guest.id"
            class="card"
            :data-guest-id="guest.id"
          >
            {{ guest.name }}
          </li>
        </ul>
      </article>

      <article
        v-for="table in tables"
        :key="table.id"
        class="col"
        :class="{ full: table.guests.length >= table.capacity, over: table.guests.length > table.capacity }"
      >
        <header class="col-h">
          <input
            class="name"
            :value="table.name"
            @change="renameTable(table.id, $event.target.value)"
          />
          <div class="right">
            <span class="n">{{ table.guests.length }}/{{ table.capacity }}</span>
            <select
              class="cap"
              :value="table.capacity"
              @change="setCapacity(table.id, Number($event.target.value))"
            >
              <option v-for="c in CAPACITIES" :key="c" :value="c">{{ c }}</option>
            </select>
            <button type="button" class="x" @click="removeTable(table.id)" aria-label="Supprimer">×</button>
          </div>
        </header>
        <p class="host">{{ table.invitedBy }}</p>
        <ul
          :ref="(el) => setListRef(table.id, el)"
          class="list"
          :data-table-id="table.id"
        >
          <li
            v-for="guest in table.guests"
            :key="guest.id"
            class="card"
            :data-guest-id="guest.id"
          >
            <span>{{ guest.name }}</span>
            <button type="button" class="x tiny" @click.stop="unplaceGuest(guest.id)" aria-label="Retirer">×</button>
          </li>
        </ul>
      </article>
    </section>

    <div v-if="showAddTable" class="overlay" @click.self="showAddTable = false">
      <div class="modal">
        <h2>Nouvelle table</h2>
        <input v-model="newTableName" type="text" placeholder="Nom" />
        <input v-model="newTableHost" type="text" placeholder="Invité par" />
        <div class="caps">
          <button
            v-for="c in CAPACITIES"
            :key="c"
            type="button"
            :class="{ on: newTableCap === c }"
            @click="newTableCap = c"
          >
            {{ c }}
          </button>
        </div>
        <div class="modal-actions">
          <button type="button" class="link muted" @click="showAddTable = false">Annuler</button>
          <button type="button" class="link" @click="addTable">Créer</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import Sortable from 'sortablejs'
import { CAPACITIES, initialTables } from './data/tables.js'

const STORAGE_KEY = 'plan-de-table-v1'
const SYNC_URL = import.meta.env.VITE_SYNC_URL || '/api/state'

function uid() {
  return crypto.randomUUID()
}

function hydrate(raw) {
  return raw.map((t) => ({
    ...t,
    guests: t.guests.map((g) =>
      typeof g === 'string' ? { id: uid(), name: g.trim() } : g,
    ),
  }))
}

function loadLocal() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      return { tables: parsed.tables, unassigned: parsed.unassigned || [] }
    }
  } catch {
    /* ignore */
  }
  return { tables: hydrate(initialTables), unassigned: [] }
}

const state = loadLocal()
const tables = ref(state.tables)
const unassigned = ref(state.unassigned)
const toast = ref('')
const showAddTable = ref(false)
const newTableName = ref('')
const newTableHost = ref('')
const newTableCap = ref(10)
const syncStatus = ref('')
const syncLabel = ref('')

const unassignedList = ref(null)
const listRefs = new Map()
const sortables = []
let toastTimer
let syncTimer
let pushTimer
let applyingRemote = false
let lastRemoteHash = ''

function setListRef(id, el) {
  if (el) listRefs.set(id, el)
  else listRefs.delete(id)
}

const placedCount = computed(() => tables.value.reduce((n, t) => n + t.guests.length, 0))
const totalSeats = computed(() => tables.value.reduce((n, t) => n + t.capacity, 0))

function payload() {
  return { tables: tables.value, unassigned: unassigned.value, updatedAt: Date.now() }
}

function hashPayload(data) {
  return JSON.stringify({ tables: data.tables, unassigned: data.unassigned })
}

function persistLocal() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ tables: tables.value, unassigned: unassigned.value }),
  )
}

watch([tables, unassigned], () => {
  if (applyingRemote) return
  persistLocal()
  schedulePush()
}, { deep: true })

function showToast(msg) {
  toast.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = ''
  }, 2200)
}

function findGuest(guestId) {
  const uIdx = unassigned.value.findIndex((g) => g.id === guestId)
  if (uIdx !== -1) return { from: 'unassigned', index: uIdx, guest: unassigned.value[uIdx] }
  for (const table of tables.value) {
    const index = table.guests.findIndex((g) => g.id === guestId)
    if (index !== -1) return { from: table.id, index, guest: table.guests[index], table }
  }
  return null
}

function removeFromSource(loc) {
  if (loc.from === 'unassigned') unassigned.value.splice(loc.index, 1)
  else loc.table.guests.splice(loc.index, 1)
}

function getTargetList(tableId) {
  if (tableId === 'unassigned') return unassigned.value
  return tables.value.find((t) => t.id === tableId)?.guests
}

function canAccept(tableId) {
  if (tableId === 'unassigned') return true
  const table = tables.value.find((t) => t.id === tableId)
  return table ? table.guests.length < table.capacity : false
}

function moveGuest(guestId, toTableId, toIndex) {
  const loc = findGuest(guestId)
  if (!loc) return false

  if (loc.from === toTableId) {
    const list = getTargetList(toTableId)
    if (!list) return false
    const [guest] = list.splice(loc.index, 1)
    const idx = toIndex > loc.index ? toIndex - 1 : toIndex
    list.splice(Math.max(0, Math.min(idx, list.length)), 0, guest)
    return true
  }

  if (toTableId !== 'unassigned') {
    const table = tables.value.find((t) => t.id === toTableId)
    if (!table || table.guests.length >= table.capacity) {
      showToast(`Table pleine (${table?.capacity ?? '?'} places)`)
      return false
    }
  }

  removeFromSource(loc)
  const list = getTargetList(toTableId)
  if (!list) return false
  list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, loc.guest)
  return true
}

function unplaceGuest(guestId) {
  moveGuest(guestId, 'unassigned', unassigned.value.length)
}

function setCapacity(tableId, capacity) {
  if (!CAPACITIES.includes(capacity)) return
  const table = tables.value.find((t) => t.id === tableId)
  if (!table) return
  if (table.guests.length > capacity) {
    showToast(`Trop d'invités pour ${capacity} places`)
    return
  }
  table.capacity = capacity
}

function renameTable(tableId, name) {
  const table = tables.value.find((t) => t.id === tableId)
  if (table && name.trim()) table.name = name.trim()
}

function addTable() {
  tables.value.push({
    id: uid(),
    name: newTableName.value.trim() || `Table ${tables.value.length + 1}`,
    capacity: newTableCap.value,
    invitedBy: newTableHost.value.trim() || '—',
    status: '-',
    guests: [],
  })
  showAddTable.value = false
  newTableName.value = ''
  newTableHost.value = ''
  newTableCap.value = 10
  nextTick(initSortables)
}

function removeTable(tableId) {
  const idx = tables.value.findIndex((t) => t.id === tableId)
  if (idx === -1) return
  const [table] = tables.value.splice(idx, 1)
  unassigned.value.push(...table.guests)
  nextTick(initSortables)
}

function resetData() {
  if (!confirm('Réinitialiser le plan ?')) return
  localStorage.removeItem(STORAGE_KEY)
  const fresh = { tables: hydrate(initialTables), unassigned: [] }
  applyingRemote = true
  tables.value = fresh.tables
  unassigned.value = fresh.unassigned
  applyingRemote = false
  persistLocal()
  schedulePush()
  nextTick(initSortables)
}

function applyRemote(data) {
  if (!data?.tables) return
  applyingRemote = true
  tables.value = data.tables
  unassigned.value = data.unassigned || []
  lastRemoteHash = hashPayload(data)
  applyingRemote = false
  persistLocal()
  nextTick(initSortables)
}

async function pullRemote() {
  if (!SYNC_URL) return
  try {
    const res = await fetch(SYNC_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error('pull failed')
    const data = await res.json()
    if (!data || !data.tables) {
      syncStatus.value = 'ok'
      syncLabel.value = 'cloud'
      await pushRemote()
      return
    }
    const remoteHash = hashPayload(data)
    const localHash = hashPayload(payload())
    if (remoteHash !== localHash && remoteHash !== lastRemoteHash) {
      if (data.updatedAt && data.updatedAt > (payload().updatedAt || 0) - 500) {
        applyRemote(data)
      }
    }
    lastRemoteHash = remoteHash
    syncStatus.value = 'ok'
    syncLabel.value = 'sync'
  } catch {
    syncStatus.value = 'err'
    syncLabel.value = 'hors ligne'
  }
}

async function pushRemote() {
  if (!SYNC_URL || applyingRemote) return
  try {
    const body = payload()
    const res = await fetch(SYNC_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error('push failed')
    lastRemoteHash = hashPayload(body)
    syncStatus.value = 'ok'
    syncLabel.value = 'sync'
  } catch {
    syncStatus.value = 'err'
    syncLabel.value = 'hors ligne'
  }
}

function schedulePush() {
  if (!SYNC_URL) return
  clearTimeout(pushTimer)
  syncLabel.value = '…'
  syncStatus.value = ''
  pushTimer = setTimeout(pushRemote, 450)
}

function destroySortables() {
  while (sortables.length) sortables.pop().destroy()
}

function initSortables() {
  destroySortables()
  const els = [unassignedList.value, ...listRefs.values()].filter(Boolean)
  els.forEach((el) => {
    sortables.push(
      Sortable.create(el, {
        group: 'guests',
        animation: 120,
        ghostClass: 'ghost',
        chosenClass: 'chosen',
        onMove(evt) {
          const toId = evt.to.dataset.tableId
          const fromId = evt.from.dataset.tableId
          if (toId === fromId) return true
          return canAccept(toId)
        },
        onAdd(evt) {
          moveGuest(evt.item.dataset.guestId, evt.to.dataset.tableId, evt.newIndex)
          nextTick(resyncDom)
        },
        onUpdate(evt) {
          moveGuest(evt.item.dataset.guestId, evt.to.dataset.tableId, evt.newIndex)
          nextTick(resyncDom)
        },
      }),
    )
  })
}

function resyncDom() {
  tables.value = tables.value.map((t) => ({ ...t, guests: [...t.guests] }))
  unassigned.value = [...unassigned.value]
  nextTick(initSortables)
}

onMounted(async () => {
  nextTick(initSortables)
  if (SYNC_URL) {
    syncLabel.value = 'sync'
    await pullRemote()
    syncTimer = setInterval(pullRemote, 4000)
  }
})

onBeforeUnmount(() => {
  destroySortables()
  clearTimeout(toastTimer)
  clearTimeout(pushTimer)
  clearInterval(syncTimer)
})
</script>

<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap');

:root {
  --bg: #fafafa;
  --ink: #111;
  --muted: #888;
  --line: #e6e6e6;
  --card: #fff;
  --full: #111;
  --over: #c0392b;
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  color: var(--ink);
  background: var(--bg);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
}

.app {
  min-height: 100vh;
  padding: 0 0 2rem;
}

.bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.85rem 1.25rem;
  background: rgba(250, 250, 250, 0.92);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(8px);
}

.bar-left, .bar-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

h1 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.sep, .counts { color: var(--muted); font-size: 0.85rem; }
.counts.muted { color: #bbb; }

.sync {
  font-size: 0.75rem;
  color: var(--muted);
  margin-left: 0.35rem;
}
.sync.ok { color: #2d8a4e; }
.sync.err { color: var(--over); }

.link {
  background: none;
  border: none;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--ink);
  cursor: pointer;
  padding: 0.25rem 0.4rem;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.link.muted { color: var(--muted); text-decoration: none; }
.link:hover { opacity: 0.7; }

.toast {
  position: fixed;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  margin: 0;
  background: var(--ink);
  color: #fff;
  font-size: 0.85rem;
  padding: 0.5rem 0.9rem;
  border-radius: 6px;
  z-index: 30;
}

.board {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  padding: 1rem 1.25rem;
  align-items: flex-start;
}

.col {
  flex: 0 0 240px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0.65rem;
  max-height: calc(100vh - 5.5rem);
  display: flex;
  flex-direction: column;
}

.col.bare {
  background: transparent;
  border-style: dashed;
}

.col.full { border-color: #bbb; }
.col.over { border-color: var(--over); }

.col-h {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.15rem;
}

.col-h > span:first-child {
  font-size: 0.8rem;
  font-weight: 600;
}

.name {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0;
  color: var(--ink);
}
.name:focus { outline: none; }

.right {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-shrink: 0;
}

.n {
  font-size: 0.75rem;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.col.full .n { color: var(--full); font-weight: 600; }
.col.over .n { color: var(--over); font-weight: 600; }

.cap {
  font: inherit;
  font-size: 0.7rem;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--ink);
  padding: 0.1rem 0.15rem;
  cursor: pointer;
}

.x {
  border: none;
  background: none;
  color: #bbb;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  padding: 0 0.15rem;
}
.x:hover { color: var(--over); }
.x.tiny {
  font-size: 0.85rem;
  opacity: 0;
}
.card:hover .x.tiny { opacity: 1; }

.host {
  margin: 0 0 0.5rem;
  font-size: 0.7rem;
  color: #aaa;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-height: 2.5rem;
  flex: 1;
}

.card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.35rem;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.4rem 0.5rem;
  font-size: 0.8rem;
  cursor: grab;
  user-select: none;
}
.card:active { cursor: grabbing; }

.ghost { opacity: 0.35; }
.chosen { background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.25);
  display: grid;
  place-items: center;
  z-index: 40;
  padding: 1rem;
}

.modal {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 1.1rem;
  width: min(320px, 100%);
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.modal h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.modal input {
  font: inherit;
  font-size: 0.9rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
}

.caps {
  display: flex;
  gap: 0.35rem;
}

.caps button {
  flex: 1;
  font: inherit;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0.45rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
.caps button.on {
  background: var(--ink);
  color: #fff;
  border-color: var(--ink);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.25rem;
}

@media (max-width: 640px) {
  .bar { padding: 0.75rem 1rem; }
  .board { padding: 0.75rem 1rem; }
  .col { flex-basis: 220px; }
}
</style>
