/**
 * Virtual Tab Groups — Storage Layer
 * CRUD operations for groups, settings, and snapshots.
 */

import { STORAGE_KEYS, DEFAULT_SETTINGS, CURRENT_SCHEMA_VERSION, UNGROUPED_ID } from './constants.js';

const { GROUPS, SETTINGS, SNAPSHOTS, SCHEMA_VERSION } = STORAGE_KEYS;

/* ─── helpers ─── */

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function getStore(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? fallback;
}

async function setStore(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/* ─── schema migration ─── */

export async function ensureSchema() {
  const version = await getStore(SCHEMA_VERSION, 0);
  if (version < CURRENT_SCHEMA_VERSION) {
    // Initialize fresh if no schema exists
    const groups = await getStore(GROUPS, null);
    if (groups === null) {
      await setStore(GROUPS, []);
      await setStore(SETTINGS, { ...DEFAULT_SETTINGS });
      await setStore(SNAPSHOTS, []);
    }
    await setStore(SCHEMA_VERSION, CURRENT_SCHEMA_VERSION);
  }
}

/* ─── Groups ─── */

export async function getGroups() {
  return getStore(GROUPS, []);
}

export async function getGroupById(groupId) {
  const groups = await getGroups();
  return groups.find(g => g.id === groupId) || null;
}

export async function createGroup(name, color, tabIds = []) {
  const groups = await getGroups();
  const newGroup = {
    id: generateId(),
    name,
    color,
    tabIds,
    createdAt: Date.now(),
    order: groups.length,
  };

  // Remove these tabIds from any other group
  for (const g of groups) {
    g.tabIds = g.tabIds.filter(id => !tabIds.includes(id));
  }

  groups.push(newGroup);
  await setStore(GROUPS, groups);
  return newGroup;
}

export async function updateGroup(groupId, updates) {
  const groups = await getGroups();
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx === -1) return null;
  Object.assign(groups[idx], updates);
  await setStore(GROUPS, groups);
  return groups[idx];
}

export async function deleteGroup(groupId) {
  let groups = await getGroups();
  groups = groups.filter(g => g.id !== groupId);
  // Re-order
  groups.forEach((g, i) => (g.order = i));
  await setStore(GROUPS, groups);
}

export async function reorderGroups(orderedIds) {
  const groups = await getGroups();
  const map = Object.fromEntries(groups.map(g => [g.id, g]));
  const reordered = orderedIds.map((id, i) => {
    if (map[id]) {
      map[id].order = i;
      return map[id];
    }
    return null;
  }).filter(Boolean);

  // Append any groups not in the orderedIds list
  const remaining = groups.filter(g => !orderedIds.includes(g.id));
  remaining.forEach((g, i) => (g.order = reordered.length + i));
  await setStore(GROUPS, [...reordered, ...remaining]);
}

export async function assignTabsToGroup(tabIds, groupId) {
  const groups = await getGroups();

  // Remove tabIds from all groups first (a tab can only be in one group)
  for (const g of groups) {
    g.tabIds = g.tabIds.filter(id => !tabIds.includes(id));
  }

  // Add to target group
  const target = groups.find(g => g.id === groupId);
  if (target) {
    target.tabIds = [...new Set([...target.tabIds, ...tabIds])];
  }

  await setStore(GROUPS, groups);
}

export async function removeTabFromGroups(tabId) {
  const groups = await getGroups();
  let changed = false;
  for (const g of groups) {
    const before = g.tabIds.length;
    g.tabIds = g.tabIds.filter(id => id !== tabId);
    if (g.tabIds.length !== before) changed = true;
  }
  if (changed) await setStore(GROUPS, groups);
}

export async function getUngroupedTabIds(allTabIds) {
  const groups = await getGroups();
  const grouped = new Set(groups.flatMap(g => g.tabIds));
  return allTabIds.filter(id => !grouped.has(id));
}

/* ─── Settings ─── */

export async function getSettings() {
  return getStore(SETTINGS, { ...DEFAULT_SETTINGS });
}

export async function updateSettings(updates) {
  const settings = await getSettings();
  Object.assign(settings, updates);
  await setStore(SETTINGS, settings);
  return settings;
}

/* ─── Snapshots ─── */

export async function getSnapshots() {
  return getStore(SNAPSHOTS, []);
}

export async function createSnapshot(name, groups, tabs) {
  const snapshots = await getSnapshots();
  const snapshot = {
    id: generateId(),
    name,
    timestamp: Date.now(),
    groups: groups.map(g => ({ ...g })),
    tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, favIconUrl: t.favIconUrl })),
  };
  snapshots.unshift(snapshot); // newest first
  // Keep max 20 snapshots
  if (snapshots.length > 20) snapshots.length = 20;
  await setStore(SNAPSHOTS, snapshots);
  return snapshot;
}

export async function deleteSnapshot(snapshotId) {
  let snapshots = await getSnapshots();
  snapshots = snapshots.filter(s => s.id !== snapshotId);
  await setStore(SNAPSHOTS, snapshots);
}
