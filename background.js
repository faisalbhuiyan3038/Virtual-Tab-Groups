/**
 * Virtual Tab Groups — Background Service Worker
 * Tab tracking, bookmark operations, snapshot creation, message handling.
 */

import {
  ensureSchema,
  getGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  assignTabsToGroup,
  removeTabFromGroups,
  getUngroupedTabIds,
  getSettings,
  updateSettings,
  getSnapshots,
  createSnapshot,
  deleteSnapshot,
} from './shared/storage.js';

import * as Raindrop from './shared/raindrop.js';

/* ─── Initialization ─── */

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSchema();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSchema();
  await cleanupStaleTabIds();
});

/* ─── Tab event listeners ─── */

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await removeTabFromGroups(tabId);
});

// When a tab is replaced (e.g. prerender), update references
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const groups = await getGroups();
  let changed = false;
  for (const g of groups) {
    const idx = g.tabIds.indexOf(removedTabId);
    if (idx !== -1) {
      g.tabIds[idx] = addedTabId;
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ vtg_groups: groups });
  }
});

/* ─── Cleanup ─── */

async function cleanupStaleTabIds() {
  try {
    const tabs = await chrome.tabs.query({});
    const liveIds = new Set(tabs.map(t => t.id));
    const groups = await getGroups();
    let changed = false;
    for (const g of groups) {
      const before = g.tabIds.length;
      g.tabIds = g.tabIds.filter(id => liveIds.has(id));
      if (g.tabIds.length !== before) changed = true;
    }
    if (changed) {
      await chrome.storage.local.set({ vtg_groups: groups });
    }
  } catch (e) {
    console.warn('[VTG] cleanupStaleTabIds error:', e);
  }
}

/* ─── Bookmark operations (Raindrop) ─── */

let cachedCollectionTree = null;
let lastTreeFetchTime = 0;
const TREE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getFullCollectionTree(forceRefresh = false) {
  if (!forceRefresh && cachedCollectionTree && (Date.now() - lastTreeFetchTime < TREE_CACHE_TTL)) {
    return cachedCollectionTree;
  }

  // Fetch root and child collections, then combine into a tree
  try {
    const [roots, children] = await Promise.all([
      Raindrop.getRootCollections(),
      Raindrop.getChildCollections()
    ]);

    const buildTree = (parentId = null) => {
      const parentNodes = parentId === null
        ? roots.map(r => ({ ...r, id: r._id, title: r.title }))
        : children.filter(c => c.parent?.$id === parentId).map(c => ({ ...c, id: c._id, title: c.title }));
      
      return parentNodes.map(node => ({
        ...node,
        children: buildTree(node.id)
      }));
    };

    const tree = buildTree();
    cachedCollectionTree = tree;
    lastTreeFetchTime = Date.now();
    return tree;
  } catch (err) {
    if (err.message === 'NO_API_KEY') {
      return { error: 'NO_API_KEY' };
    }
    throw err;
  }
}

async function saveTabsToRaindrop(tabs, collectionId, options = {}) {
  const { closeTabs = false } = options;

  await Raindrop.saveBookmarks(tabs, collectionId);

  // Optionally close tabs
  if (closeTabs) {
    const tabIds = tabs.map(t => t.id).filter(Boolean);
    if (tabIds.length > 0) {
      await chrome.tabs.remove(tabIds);
    }
  }
}

/* ─── Snapshot operations ─── */

async function takeSnapshot(name) {
  const tabs = await chrome.tabs.query({});
  const groups = await getGroups();
  const snapshotName = name || `Snapshot ${new Date().toLocaleString()}`;
  return createSnapshot(snapshotName, groups, tabs);
}

async function restoreSnapshot(snapshotId) {
  const snapshots = await getSnapshots();
  const snapshot = snapshots.find(s => s.id === snapshotId);
  if (!snapshot) return { success: false, error: 'Snapshot not found' };

  // Open all tabs from the snapshot
  const tabIdMap = {}; // old tab id → new tab id
  for (const tab of snapshot.tabs) {
    try {
      const newTab = await chrome.tabs.create({ url: tab.url, active: false });
      tabIdMap[tab.id] = newTab.id;
    } catch (e) {
      console.warn('[VTG] Failed to restore tab:', tab.url, e);
    }
  }

  // Recreate groups with new tab ids
  for (const group of snapshot.groups) {
    const newTabIds = group.tabIds
      .map(oldId => tabIdMap[oldId])
      .filter(Boolean);
    if (newTabIds.length > 0) {
      await createGroup(group.name, group.color, newTabIds);
    }
  }

  return { success: true, tabCount: Object.keys(tabIdMap).length };
}

/* ─── Message handler ─── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    console.error('[VTG] Message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  switch (msg.action) {
    /* ── Tab queries ── */
    case 'getTabs':
      return chrome.tabs.query({});

    case 'switchToTab':
      await chrome.tabs.update(msg.tabId, { active: true });
      if (msg.windowId) await chrome.windows.update(msg.windowId, { focused: true });
      return { success: true };

    case 'closeTabs':
      await chrome.tabs.remove(msg.tabIds);
      return { success: true };

    /* ── Groups ── */
    case 'getGroups':
      return getGroups();

    case 'createGroup':
      return createGroup(msg.name, msg.color, msg.tabIds || []);

    case 'updateGroup':
      return updateGroup(msg.groupId, msg.updates);

    case 'deleteGroup':
      await deleteGroup(msg.groupId);
      return { success: true };

    case 'reorderGroups':
      await reorderGroups(msg.orderedIds);
      return { success: true };

    case 'assignTabsToGroup':
      await assignTabsToGroup(msg.tabIds, msg.groupId);
      return { success: true };

    case 'getUngroupedTabIds': {
      const tabs = await chrome.tabs.query({});
      return getUngroupedTabIds(tabs.map(t => t.id));
    }

    /* ── Bookmarks (Raindrop) ── */
    case 'saveToBookmarks':
      await saveTabsToRaindrop(msg.tabs, msg.folderId, msg.options || {});
      return { success: true };

    case 'createBookmarkFolder':
      const newCollection = await Raindrop.createCollection(msg.name, msg.parentId);
      cachedCollectionTree = null; // Clear cache on new collection
      return newCollection;

    case 'getBookmarkTree':
      return getFullCollectionTree(msg.forceRefresh);

    case 'getRaindrops':
      return Raindrop.getBookmarks(msg.collectionId);

    case 'checkRaindropAuth':
      return Raindrop.checkAuth();

    /* ── Snapshots ── */
    case 'takeSnapshot':
      return takeSnapshot(msg.name);

    case 'getSnapshots':
      return getSnapshots();

    case 'restoreSnapshot':
      return restoreSnapshot(msg.snapshotId);

    case 'deleteSnapshot':
      await deleteSnapshot(msg.snapshotId);
      return { success: true };

    /* ── Settings ── */
    case 'getSettings':
      return getSettings();

    case 'updateSettings':
      return updateSettings(msg.updates);

    default:
      return { error: `Unknown action: ${msg.action}` };
  }
}
