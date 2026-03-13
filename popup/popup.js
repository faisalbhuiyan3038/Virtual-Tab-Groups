/**
 * Virtual Tab Groups — Popup UI Logic
 * Handles tab rendering, selection, grouping, bookmarks, and snapshots.
 */

import { GROUP_COLORS, UNGROUPED_ID } from '../shared/constants.js';

const isFirefox = navigator.userAgent.includes('Firefox');

/* ═══════════════════════════════════════════════════
   State
   ═══════════════════════════════════════════════════ */
const state = {
  tabs: [],
  groups: [],
  settings: {},
  selectedTabIds: new Set(),
  selectionMode: false,
  activePanel: 'tabsPanel',
  searchQuery: '',
  collapsedGroups: new Set(),
  // Folder picker
  selectedFolderId: null,
  pendingBookmarkTabs: [],
  // Group edit
  editingGroupId: null,
  selectedColor: GROUP_COLORS[0].id,
  // Bookmark target
  bookmarkTarget: 'raindrop',
  // Long-press
  longPressTimer: null,
};

/* ═══════════════════════════════════════════════════
   Messaging helper
   ═══════════════════════════════════════════════════ */
function msg(action, data = {}) {
  return chrome.runtime.sendMessage({ action, ...data });
}

/* ═══════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  renderTabs();
  renderBookmarkTree();
  renderSnapshots();
  bindEvents();
  applyTheme();

  if (!isFirefox) {
    document.getElementById('btnSaveLocal').classList.remove('hidden');
    document.getElementById('menuQuickSaveLocal').classList.remove('hidden');
  }
});

async function loadData() {
  const [tabs, groups, settings] = await Promise.all([
    msg('getTabs'),
    msg('getGroups'),
    msg('getSettings'),
  ]);
  state.tabs = tabs || [];
  state.groups = (groups || []).sort((a, b) => a.order - b.order);
  state.settings = settings || {};
}

/* ═══════════════════════════════════════════════════
   Theme
   ═══════════════════════════════════════════════════ */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme || 'auto');
}

/* ═══════════════════════════════════════════════════
   Tab Rendering
   ═══════════════════════════════════════════════════ */
function renderTabs() {
  const container = document.getElementById('tabList');
  const emptyState = document.getElementById('emptyState');
  container.innerHTML = '';

  const tabs = getFilteredTabs();

  if (tabs.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  // Build grouped + ungrouped sections
  const groupedTabIds = new Set(state.groups.flatMap(g => g.tabIds));
  const tabMap = Object.fromEntries(tabs.map(t => [t.id, t]));

  // Render each group
  for (const group of state.groups) {
    const groupTabs = group.tabIds.map(id => tabMap[id]).filter(Boolean);
    if (groupTabs.length === 0 && state.searchQuery) continue; // hide empty groups during search
    renderGroupSection(container, group, groupTabs);
  }

  // Render ungrouped
  const ungroupedTabs = tabs.filter(t => !groupedTabIds.has(t.id));
  if (ungroupedTabs.length > 0) {
    renderGroupSection(container, {
      id: UNGROUPED_ID,
      name: 'Ungrouped',
      color: 'slate',
      tabIds: ungroupedTabs.map(t => t.id),
    }, ungroupedTabs);
  }
}

function renderGroupSection(container, group, tabs) {
  const color = GROUP_COLORS.find(c => c.id === group.color)?.hex || '#64748B';
  const isCollapsed = state.collapsedGroups.has(group.id);
  const isUngrouped = group.id === UNGROUPED_ID;

  const section = document.createElement('div');
  section.className = 'group-section';
  section.dataset.groupId = group.id;

  // Header
  const header = document.createElement('div');
  header.className = `group-header${isCollapsed ? ' collapsed' : ''}`;
  header.innerHTML = `
    <div class="group-color-dot" style="background:${color}"></div>
    <span class="group-name">${escapeHtml(group.name)}</span>
    <span class="group-count">${tabs.length}</span>
    ${!isUngrouped ? `<button class="group-actions-btn" data-group-id="${group.id}" title="Group options">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
    </button>` : ''}
    <svg class="group-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
  `;

  // Toggle collapse
  header.addEventListener('click', (e) => {
    if (e.target.closest('.group-actions-btn')) return;
    toggleGroupCollapse(group.id, header, tabsContainer);
  });

  // Group context menu
  const actionsBtn = header.querySelector('.group-actions-btn');
  if (actionsBtn) {
    actionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showGroupContextMenu(group, e);
    });
  }

  section.appendChild(header);

  // Tabs container
  const tabsContainer = document.createElement('div');
  tabsContainer.className = `group-tabs${isCollapsed ? ' collapsed' : ''}`;

  for (const tab of tabs) {
    tabsContainer.appendChild(createTabItem(tab));
  }

  // Set max-height for animation
  if (!isCollapsed) {
    requestAnimationFrame(() => {
      tabsContainer.style.maxHeight = tabsContainer.scrollHeight + 'px';
    });
  }

  section.appendChild(tabsContainer);
  container.appendChild(section);
}

function createTabItem(tab) {
  const el = document.createElement('div');
  el.className = `tab-item${tab.active ? ' active-tab' : ''}`;
  el.dataset.tabId = tab.id;
  el.dataset.url = tab.url || '';

  const isSelected = state.selectedTabIds.has(tab.id);
  const hostname = getHostname(tab.url);

  el.innerHTML = `
    <div class="checkbox ${state.selectionMode ? 'visible' : ''} ${isSelected ? 'checked' : ''}"></div>
    ${getFaviconHtml(tab)}
    <div class="tab-info">
      <div class="tab-title">${escapeHtml(tab.title || 'Untitled')}</div>
      <div class="tab-url">${escapeHtml(hostname)}</div>
    </div>
  `;

  // Click handler
  el.addEventListener('click', () => onTabClick(tab, el));

  // Long-press for selection mode
  el.addEventListener('pointerdown', (e) => {
    if (state.selectionMode) return;
    state.longPressTimer = setTimeout(() => {
      enterSelectionMode(tab.id);
    }, 500);
  });
  el.addEventListener('pointerup', () => clearTimeout(state.longPressTimer));
  el.addEventListener('pointerleave', () => clearTimeout(state.longPressTimer));
  el.addEventListener('pointercancel', () => clearTimeout(state.longPressTimer));

  return el;
}

function onTabClick(tab, el) {
  if (state.selectionMode) {
    toggleTabSelection(tab.id, el);
  } else {
    // Switch to this tab
    msg('switchToTab', { tabId: tab.id, windowId: tab.windowId });
  }
}

/* ═══════════════════════════════════════════════════
   Selection Mode
   ═══════════════════════════════════════════════════ */
function enterSelectionMode(initialTabId) {
  state.selectionMode = true;
  state.selectedTabIds.clear();
  if (initialTabId) state.selectedTabIds.add(initialTabId);
  updateSelectionUI();
  renderTabs();
}

function exitSelectionMode() {
  state.selectionMode = false;
  state.selectedTabIds.clear();
  document.getElementById('selectionBar').classList.add('hidden');
  document.getElementById('bottomToolbar').classList.add('hidden');
  document.getElementById('topBar').classList.remove('hidden');
  renderTabs();
}

function toggleTabSelection(tabId, el) {
  if (state.selectedTabIds.has(tabId)) {
    state.selectedTabIds.delete(tabId);
  } else {
    state.selectedTabIds.add(tabId);
  }

  // Update checkbox visually
  const checkbox = el?.querySelector('.checkbox');
  if (checkbox) {
    checkbox.classList.toggle('checked', state.selectedTabIds.has(tabId));
  }

  updateSelectionUI();

  // Exit selection if nothing selected
  if (state.selectedTabIds.size === 0) {
    exitSelectionMode();
  }
}

function updateSelectionUI() {
  const bar = document.getElementById('selectionBar');
  const toolbar = document.getElementById('bottomToolbar');
  const topBar = document.getElementById('topBar');
  const count = state.selectedTabIds.size;

  if (state.selectionMode && count > 0) {
    bar.classList.remove('hidden');
    toolbar.classList.remove('hidden');
    topBar.classList.add('hidden');
    document.getElementById('selectionCount').textContent = `${count} selected`;
  } else {
    bar.classList.add('hidden');
    toolbar.classList.add('hidden');
    topBar.classList.remove('hidden');
  }
}

function selectAllInDomain() {
  // Find the domain from the first selected tab
  const firstSelectedId = [...state.selectedTabIds][0];
  if (!firstSelectedId) return;
  const firstTab = state.tabs.find(t => t.id === firstSelectedId);
  if (!firstTab) return;
  const domain = getHostname(firstTab.url);

  for (const tab of state.tabs) {
    if (getHostname(tab.url) === domain) {
      state.selectedTabIds.add(tab.id);
    }
  }
  updateSelectionUI();
  renderTabs();
}

function selectAll() {
  const filtered = getFilteredTabs();
  for (const tab of filtered) {
    state.selectedTabIds.add(tab.id);
  }
  updateSelectionUI();
  renderTabs();
}

/* ═══════════════════════════════════════════════════
   Group Collapse
   ═══════════════════════════════════════════════════ */
function toggleGroupCollapse(groupId, header, tabsContainer) {
  const isCollapsed = state.collapsedGroups.has(groupId);
  if (isCollapsed) {
    state.collapsedGroups.delete(groupId);
    header.classList.remove('collapsed');
    tabsContainer.classList.remove('collapsed');
    tabsContainer.style.maxHeight = tabsContainer.scrollHeight + 'px';
  } else {
    state.collapsedGroups.add(groupId);
    tabsContainer.style.maxHeight = tabsContainer.scrollHeight + 'px';
    requestAnimationFrame(() => {
      header.classList.add('collapsed');
      tabsContainer.classList.add('collapsed');
    });
  }
}

/* ═══════════════════════════════════════════════════
   Group Context Menu
   ═══════════════════════════════════════════════════ */
function showGroupContextMenu(group, event) {
  closeAllOverlays();
  const menu = document.createElement('div');
  menu.className = 'group-context-menu';

  menu.innerHTML = `
    <button class="menu-item" data-action="renameGroup">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      Rename
    </button>
    <button class="menu-item" data-action="saveGroupBookmark">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
      Save to Raindrop
    </button>
    ${!isFirefox ? `<button class="menu-item" data-action="saveGroupLocal">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
      Save to Local Bookmarks
    </button>` : ''}
    <button class="menu-item" data-action="selectGroupTabs">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
      Select all tabs
    </button>
    <hr class="menu-divider"/>
    <button class="menu-item danger" data-action="deleteGroup">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
      Delete group
    </button>
  `;

  // Position
  const rect = event.target.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${document.body.clientWidth - rect.right}px`;

  document.body.appendChild(menu);

  // Click handlers
  menu.addEventListener('click', async (e) => {
    const action = e.target.closest('.menu-item')?.dataset.action;
    menu.remove();
    if (!action) return;

    switch (action) {
      case 'renameGroup':
        openGroupEditModal(group);
        break;
      case 'saveGroupBookmark': {
        const tabs = group.tabIds.map(id => state.tabs.find(t => t.id === id)).filter(Boolean);
        if (tabs.length === 0) { showToast('No tabs in this group'); return; }
        state.pendingBookmarkTabs = tabs;
        openFolderPicker(group.name, false, 'raindrop');
        break;
      }
      case 'saveGroupLocal': {
        const tabs = group.tabIds.map(id => state.tabs.find(t => t.id === id)).filter(Boolean);
        if (tabs.length === 0) { showToast('No tabs in this group'); return; }
        state.pendingBookmarkTabs = tabs;
        openFolderPicker(group.name, false, 'local');
        break;
      }
      case 'selectGroupTabs':
        enterSelectionMode();
        for (const tabId of group.tabIds) state.selectedTabIds.add(tabId);
        updateSelectionUI();
        renderTabs();
        break;
      case 'deleteGroup':
        showConfirm(`Delete group "${group.name}"? Tabs will become ungrouped.`, async () => {
          await msg('deleteGroup', { groupId: group.id });
          await loadData();
          renderTabs();
          showToast('Group deleted');
        });
        break;
    }
  });

  // Close on backdrop click
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 10);
}

/* ═══════════════════════════════════════════════════
   Group Picker Modal
   ═══════════════════════════════════════════════════ */
function openGroupPicker() {
  const modal = document.getElementById('groupPickerModal');
  const list = document.getElementById('groupPickerList');
  modal.classList.remove('hidden');

  list.innerHTML = '';
  for (const group of state.groups) {
    const color = GROUP_COLORS.find(c => c.id === group.color)?.hex || '#64748B';
    const item = document.createElement('div');
    item.className = 'group-picker-item';
    item.innerHTML = `
      <div class="group-color-dot" style="background:${color}"></div>
      <span class="name">${escapeHtml(group.name)}</span>
      <span class="count">${group.tabIds.length} tabs</span>
    `;
    item.addEventListener('click', async () => {
      await msg('assignTabsToGroup', { tabIds: [...state.selectedTabIds], groupId: group.id });
      closeModal(modal);
      exitSelectionMode();
      await loadData();
      renderTabs();
      showToast(`Added to ${group.name}`);
    });
    list.appendChild(item);
  }
}

/* ═══════════════════════════════════════════════════
   Group Edit Modal (New / Rename)
   ═══════════════════════════════════════════════════ */
function openGroupEditModal(existingGroup = null) {
  const modal = document.getElementById('groupEditModal');
  const title = document.getElementById('groupEditTitle');
  const input = document.getElementById('groupNameInput');
  const saveBtn = document.getElementById('btnGroupSave');
  const colorPicker = document.getElementById('colorPicker');

  state.editingGroupId = existingGroup?.id || null;
  title.textContent = existingGroup ? 'Rename Group' : 'New Group';
  saveBtn.textContent = existingGroup ? 'Save' : 'Create';
  input.value = existingGroup?.name || '';
  state.selectedColor = existingGroup?.color || GROUP_COLORS[0].id;

  // Render color swatches
  colorPicker.innerHTML = '';
  for (const c of GROUP_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = `color-swatch${c.id === state.selectedColor ? ' selected' : ''}`;
    swatch.style.background = c.hex;
    swatch.title = c.label;
    swatch.addEventListener('click', () => {
      state.selectedColor = c.id;
      colorPicker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      swatch.classList.add('selected');
    });
    colorPicker.appendChild(swatch);
  }

  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 100);
}

async function saveGroup() {
  const input = document.getElementById('groupNameInput');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }

  if (state.editingGroupId) {
    // Rename
    await msg('updateGroup', { groupId: state.editingGroupId, updates: { name, color: state.selectedColor } });
    showToast('Group updated');
  } else {
    // Create new
    const tabIds = [...state.selectedTabIds];
    await msg('createGroup', { name, color: state.selectedColor, tabIds });
    showToast(`Group "${name}" created`);
    exitSelectionMode();
  }

  closeModal(document.getElementById('groupEditModal'));
  await loadData();
  renderTabs();
}

/* ═══════════════════════════════════════════════════
   Settings Modal (Raindrop API)
   ═══════════════════════════════════════════════════ */
function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const input = document.getElementById('raindropTokenInput');
  const statusEl = document.getElementById('apiStatusMessage');

  input.value = state.settings.raindropApiKey || '';
  statusEl.classList.add('hidden');
  statusEl.className = 'status-msg hidden';
  
  modal.classList.remove('hidden');
}

async function testApiKey() {
  const input = document.getElementById('raindropTokenInput');
  const statusEl = document.getElementById('apiStatusMessage');
  const token = input.value.trim();
  
  if (!token) {
    statusEl.textContent = 'Please enter a token first.';
    statusEl.className = 'status-msg error';
    statusEl.classList.remove('hidden');
    return;
  }

  // Temporarily save to test
  await msg('updateSettings', { updates: { raindropApiKey: token } });
  
  try {
    const user = await msg('checkRaindropAuth');
    statusEl.textContent = `Connected! Logged in as ${user.fullName || user.name}`;
    statusEl.className = 'status-msg success';
    statusEl.classList.remove('hidden');
    // Refresh data in background
    if (state.activePanel === 'bookmarksPanel') renderBookmarkTree();
  } catch (err) {
    statusEl.textContent = `Error: Invalid token or network issue.`;
    statusEl.className = 'status-msg error';
    statusEl.classList.remove('hidden');
  }
}

async function saveSettingsAction() {
  const token = document.getElementById('raindropTokenInput').value.trim();
  state.settings = await msg('updateSettings', { updates: { raindropApiKey: token } });
  closeModal(document.getElementById('settingsModal'));
  showToast('Settings saved');
  if (state.activePanel === 'bookmarksPanel') renderBookmarkTree();
}

/* ═══════════════════════════════════════════════════
   Folder Picker Modal (Raindrop & Local Collections)
   ═══════════════════════════════════════════════════ */
async function openFolderPicker(defaultName = '', forceRefresh = false, target = 'raindrop') {
  state.bookmarkTarget = target;

  if (target === 'raindrop' && !state.settings.raindropApiKey) {
    showToast('Raindrop API Key required');
    openSettingsModal();
    return;
  }

  const modal = document.getElementById('folderPickerModal');
  const tree = document.getElementById('folderTree');
  const newFolderInput = document.getElementById('newFolderName');
  const errorEl = document.getElementById('folderPickerError');

  newFolderInput.value = defaultName;
  state.selectedFolderId = null;
  errorEl.classList.add('hidden');
  modal.classList.remove('hidden');

  // Load collections tree
  tree.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-tertiary)">Loading collections...</div>';
  
  try {
    let collectionsTree;
    if (target === 'raindrop') {
      collectionsTree = await msg('getBookmarkTree', { forceRefresh });
      if (collectionsTree.error === 'NO_API_KEY') throw new Error('NO_API_KEY');
    } else {
      collectionsTree = await msg('getLocalBookmarkTree');
    }
    
    tree.innerHTML = '';
    renderFolderTree(tree, collectionsTree, 0);

    if (!collectionsTree || collectionsTree.length === 0) {
      tree.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-tertiary)">No collections found. Create one below.</div>';
    }
  } catch (err) {
    tree.innerHTML = '';
    errorEl.textContent = 'Failed to load collections.';
    errorEl.classList.remove('hidden');
  }
}

function renderFolderTree(container, nodes, depth) {
  if (!nodes || nodes.length === 0) return;
  for (const node of nodes) {
    if (state.bookmarkTarget === 'local' && node.url) continue; // Skip pure links in Chrome bookmarks (we only want folders)

    const item = document.createElement('div');
    item.className = `bookmark-folder-item${state.selectedFolderId === node.id ? ' selected' : ''}`;
    item.style.paddingLeft = `${12 + depth * 16}px`;
    item.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      <span class="folder-name">${escapeHtml(node.title || 'Unknown/Unsorted')}</span>
    `;
    item.addEventListener('click', () => {
      state.selectedFolderId = node.id;
      container.querySelectorAll('.bookmark-folder-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
    });
    container.appendChild(item);
    
    if (node.children?.length > 0) {
      renderFolderTree(container, node.children, depth + 1);
    }
  }
}

async function saveToSelectedFolder() {
  const errorEl = document.getElementById('folderPickerError');
  errorEl.classList.add('hidden');

  const closeTabs = document.getElementById('chkCloseSaved').checked;
  let tabs = state.pendingBookmarkTabs;

  if (tabs.length === 0) {
    tabs = [...state.selectedTabIds].map(id => state.tabs.find(t => t.id === id)).filter(Boolean);
  }

  if (tabs.length === 0) {
    showToast('No tabs to save');
    return;
  }

  const newFolderName = document.getElementById('newFolderName').value.trim();
  let targetFolderId = state.selectedFolderId;

  try {
    if (newFolderName) {
      // Create new collection
      if (state.bookmarkTarget === 'raindrop') {
        const newFolder = await msg('createBookmarkFolder', { name: newFolderName, parentId: state.selectedFolderId });
        targetFolderId = newFolder._id;
      } else {
        const newFolder = await msg('createLocalBookmarkFolder', { name: newFolderName, parentId: state.selectedFolderId });
        targetFolderId = newFolder.id;
      }
    } else if (!targetFolderId) {
      // Unsorted collection ID in Raindrop is usually 0 or -1, but let's just require a selection for now
      throw new Error('Please select a collection or enter a new name');
    }

    const btn = document.getElementById('btnSaveToFolder');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    if (state.bookmarkTarget === 'raindrop') {
      await msg('saveToBookmarks', {
        tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url })),
        folderId: targetFolderId,
        options: { closeTabs },
      });
    } else {
      await msg('saveToLocalBookmarks', {
        tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url })),
        folderId: targetFolderId,
        options: { closeTabs },
      });
    }

    closeModal(document.getElementById('folderPickerModal'));
    state.pendingBookmarkTabs = [];
    exitSelectionMode();

    if (closeTabs) {
      await loadData();
      renderTabs();
    }

    showToast(`${tabs.length} tab${tabs.length > 1 ? 's' : ''} saved to ${state.bookmarkTarget === 'local' ? 'Local Bookmarks' : 'Raindrop'}`);
  } catch (err) {
    errorEl.textContent = err.message || 'Failed to save bookmarks';
    errorEl.classList.remove('hidden');
  } finally {
    const btn = document.getElementById('btnSaveToFolder');
    btn.textContent = 'Save here';
    btn.disabled = false;
  }
}

async function createSubfolder() {
  const input = document.getElementById('newFolderName');
  const errorEl = document.getElementById('folderPickerError');
  errorEl.classList.add('hidden');

  const name = input.value.trim();
  if (!name) {
    errorEl.textContent = 'Enter a collection name';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const btn = document.getElementById('btnCreateFolder');
    btn.textContent = '...';
    btn.disabled = true;

    let newFolder;
    if (state.bookmarkTarget === 'raindrop') {
      newFolder = await msg('createBookmarkFolder', { name, parentId: state.selectedFolderId });
      state.selectedFolderId = newFolder._id;
    } else {
      newFolder = await msg('createLocalBookmarkFolder', { name, parentId: state.selectedFolderId });
      state.selectedFolderId = newFolder.id;
    }
    input.value = '';

    // Re-render tree
    const tree = document.getElementById('folderTree');
    const collectionsTree = await msg(state.bookmarkTarget === 'local' ? 'getLocalBookmarkTree' : 'getBookmarkTree');
    tree.innerHTML = '';
    renderFolderTree(tree, collectionsTree, 0);
    showToast(`Collection "${name}" created`);
  } catch (err) {
    errorEl.textContent = err.message || 'Failed to create collection';
    errorEl.classList.remove('hidden');
  } finally {
    const btn = document.getElementById('btnCreateFolder');
    btn.textContent = 'Create';
    btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════
   Bookmark Browser Panel (Raindrop Collections)
   ═══════════════════════════════════════════════════ */
async function renderBookmarkTree(forceRefresh = false) {
  const container = document.getElementById('bookmarkTree');
  const errorState = document.getElementById('bookmarkErrorState');
  
  errorState.classList.add('hidden');
  container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-tertiary)">Loading Raindrop collections...</div>';

  try {
    const tree = await msg('getBookmarkTree', { forceRefresh });
    
    if (tree.error === 'NO_API_KEY') {
      container.innerHTML = '';
      errorState.classList.remove('hidden');
      return;
    }

    container.innerHTML = '';
    
    // Virtual "All Bookmarks" collection? For now just render the tree
    renderBookmarkNodes(container, tree, 0);
    
    if (tree.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No collections found in Raindrop.io</p></div>';
    }
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><p>Could not connect to Raindrop.io</p></div>';
  }
}

function renderBookmarkNodes(container, nodes, depth) {
  if (!nodes) return;
  for (const node of nodes) {
    const el = document.createElement('div');
    el.className = 'bookmark-node';
    el.style.paddingLeft = `${8 + depth * 14}px`;

    // Folder
    const childCount = node.count || 0; // Collection total item count
    el.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
      <span class="bm-title">${escapeHtml(node.title || 'Unsorted')}</span>
      ${childCount > 0 ? `<div class="bookmark-folder-actions">
        <button data-folder-id="${node.id}" class="open-folder-btn">Open all (${childCount})</button>
      </div>` : ''}
    `;

    const openBtn = el.querySelector('.open-folder-btn');
    if (openBtn) {
      openBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        openBtn.textContent = 'Opening...';
        openBtn.disabled = true;

        try {
          const raindrops = await msg('getRaindrops', { collectionId: node.id });
          if (!raindrops || raindrops.length === 0) {
            showToast('No links in this collection');
            return;
          }

          for (const bm of raindrops) {
            await chrome.tabs.create({ url: bm.link, active: false });
          }
          
          // Create a virtual group for them
          const tabs = await msg('getTabs');
          const newTabIds = tabs
            .filter(t => raindrops.some(b => b.link === t.url))
            .map(t => t.id);
            
          if (newTabIds.length > 0) {
            await msg('createGroup', {
              name: node.title || 'Restored',
              color: GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)].id,
              tabIds: newTabIds,
            });
          }
          await loadData();
          switchPanel('tabsPanel');
          renderTabs();
          showToast(`Opened ${raindrops.length} tabs from Raindrop`);
        } catch (err) {
          showToast('Failed to load raindrops');
        } finally {
          openBtn.textContent = `Open all (${childCount})`;
          openBtn.disabled = false;
        }
      });
    }

    container.appendChild(el);
    if (node.children?.length > 0) {
      renderBookmarkNodes(container, node.children, depth + 1);
    }
  }
}

/* ═══════════════════════════════════════════════════
   Snapshots Panel
   ═══════════════════════════════════════════════════ */
async function renderSnapshots() {
  const container = document.getElementById('snapshotList');
  const emptyState = document.getElementById('snapshotEmpty');

  const snapshots = await msg('getSnapshots');
  container.innerHTML = '';

  if (!snapshots || snapshots.length === 0) {
    emptyState.classList.remove('hidden');
    container.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  container.classList.remove('hidden');

  // Add "Take snapshot" button at top
  const takeBtn = document.createElement('button');
  takeBtn.className = 'primary-btn';
  takeBtn.style.cssText = 'width:100%;margin-bottom:12px;';
  takeBtn.textContent = 'Take new snapshot';
  takeBtn.addEventListener('click', takeSnapshotAction);
  container.appendChild(takeBtn);

  for (const snap of snapshots) {
    const item = document.createElement('div');
    item.className = 'snapshot-item';
    const date = new Date(snap.timestamp);
    const tabCount = snap.tabs?.length || 0;
    const groupCount = snap.groups?.length || 0;

    item.innerHTML = `
      <div class="snapshot-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      </div>
      <div class="snapshot-info">
        <div class="snapshot-name">${escapeHtml(snap.name)}</div>
        <div class="snapshot-meta">${tabCount} tabs · ${groupCount} groups · ${formatDate(date)}</div>
      </div>
      <div class="snapshot-actions">
        <button class="restore" title="Restore">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
        </button>
        <button class="delete" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    `;

    // Restore
    item.querySelector('.restore').addEventListener('click', async (e) => {
      e.stopPropagation();
      showConfirm(`Restore "${snap.name}"? This will open ${tabCount} tabs.`, async () => {
        const result = await msg('restoreSnapshot', { snapshotId: snap.id });
        if (result.success) {
          await loadData();
          switchPanel('tabsPanel');
          renderTabs();
          showToast(`Restored ${result.tabCount} tabs`);
        } else {
          showToast('Failed to restore snapshot');
        }
      });
    });

    // Delete
    item.querySelector('.delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      showConfirm(`Delete "${snap.name}"?`, async () => {
        await msg('deleteSnapshot', { snapshotId: snap.id });
        renderSnapshots();
        showToast('Snapshot deleted');
      });
    });

    container.appendChild(item);
  }
}

async function takeSnapshotAction() {
  await msg('takeSnapshot', { name: `Snapshot ${new Date().toLocaleString()}` });
  renderSnapshots();
  showToast('Snapshot saved');
}

/* ═══════════════════════════════════════════════════
   Navigation
   ═══════════════════════════════════════════════════ */
function switchPanel(panelId) {
  state.activePanel = panelId;

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(panelId).classList.add('active');

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nav-tab[data-panel="${panelId}"]`).classList.add('active');

  // Move indicator
  const tabs = [...document.querySelectorAll('.nav-tab')];
  const idx = tabs.findIndex(t => t.dataset.panel === panelId);
  document.getElementById('navIndicator').style.transform = `translateX(${idx * 100}%)`;

  // Refresh panel data if needed
  if (panelId === 'bookmarksPanel') renderBookmarkTree();
  if (panelId === 'snapshotsPanel') renderSnapshots();
}

/* ═══════════════════════════════════════════════════
   Search
   ═══════════════════════════════════════════════════ */
function getFilteredTabs() {
  if (!state.searchQuery) return state.tabs;
  const q = state.searchQuery.toLowerCase();
  return state.tabs.filter(t =>
    (t.title || '').toLowerCase().includes(q) ||
    (t.url || '').toLowerCase().includes(q)
  );
}

/* ═══════════════════════════════════════════════════
   Confirm Dialog
   ═══════════════════════════════════════════════════ */
let confirmCallback = null;

function showConfirm(message, onConfirm) {
  const modal = document.getElementById('confirmModal');
  document.getElementById('confirmMessage').textContent = message;
  confirmCallback = onConfirm;
  modal.classList.remove('hidden');
}

/* ═══════════════════════════════════════════════════
   Toast
   ═══════════════════════════════════════════════════ */
let toastTimer;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.classList.add('hidden'), 200);
  }, 2500);
}

/* ═══════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════ */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url || '';
  }
}

function getFaviconHtml(tab) {
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
    return `<img class="tab-favicon" src="${escapeHtml(tab.favIconUrl)}" alt="" loading="lazy" onerror="this.outerHTML=getFaviconFallback('${escapeHtml(getHostname(tab.url))}')" />`;
  }
  return getFaviconFallback(getHostname(tab.url));
}

function getFaviconFallback(hostname) {
  const letter = (hostname?.[0] || '?').toUpperCase();
  return `<div class="tab-favicon fallback">${letter}</div>`;
}

// Make fallback accessible globally for onerror
window.getFaviconFallback = getFaviconFallback;

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return date.toLocaleDateString();
}

function closeModal(modal) {
  modal.classList.add('hidden');
}

function closeAllOverlays() {
  document.querySelectorAll('.modal-overlay, .menu-overlay').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.group-context-menu').forEach(el => el.remove());
}

/* ═══════════════════════════════════════════════════
   Event Binding
   ═══════════════════════════════════════════════════ */
function bindEvents() {
  // Navigation tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchPanel(tab.dataset.panel));
  });

  // Search
  document.getElementById('btnSearch').addEventListener('click', () => {
    const bar = document.getElementById('searchBar');
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) {
      document.getElementById('searchInput').focus();
    }
  });
  document.getElementById('btnSearchClose').addEventListener('click', () => {
    document.getElementById('searchBar').classList.add('hidden');
    state.searchQuery = '';
    document.getElementById('searchInput').value = '';
    renderTabs();
  });
  document.getElementById('searchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderTabs();
  });

  // Selection bar
  document.getElementById('btnCancelSelect').addEventListener('click', exitSelectionMode);
  document.getElementById('btnSelectAllDomain').addEventListener('click', selectAllInDomain);
  document.getElementById('btnSelectAll').addEventListener('click', selectAll);

  // Bottom toolbar
  document.getElementById('btnAddToGroup').addEventListener('click', openGroupPicker);
  document.getElementById('btnSaveLocal').addEventListener('click', () => {
    const tabs = [...state.selectedTabIds].map(id => state.tabs.find(t => t.id === id)).filter(Boolean);
    if (tabs.length === 0) return;
    state.pendingBookmarkTabs = tabs;
    openFolderPicker('Selected Tabs', false, 'local');
  });
  document.getElementById('btnSaveBookmark').addEventListener('click', () => {
    const tabs = [...state.selectedTabIds].map(id => state.tabs.find(t => t.id === id)).filter(Boolean);
    if (tabs.length === 0) return;
    state.pendingBookmarkTabs = tabs;
    openFolderPicker('Selected Tabs', false, 'raindrop');
  });
  document.getElementById('btnCloseTabs').addEventListener('click', () => {
    const count = state.selectedTabIds.size;
    showConfirm(`Close ${count} tab${count > 1 ? 's' : ''}?`, async () => {
      await msg('closeTabs', { tabIds: [...state.selectedTabIds] });
      exitSelectionMode();
      await loadData();
      renderTabs();
      showToast(`${count} tab${count > 1 ? 's' : ''} closed`);
    });
  });

  // Overflow menu
  document.getElementById('btnOverflow').addEventListener('click', () => {
    document.getElementById('overflowMenu').classList.remove('hidden');
  });
  document.querySelector('#overflowMenu .menu-backdrop').addEventListener('click', () => {
    document.getElementById('overflowMenu').classList.add('hidden');
  });

  // Overflow menu items
  document.getElementById('menuQuickSave').addEventListener('click', async () => {
    closeAllOverlays();
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      state.pendingBookmarkTabs = [activeTab];
      openFolderPicker(activeTab.title, false, 'raindrop');
    }
  });
  document.getElementById('menuQuickSaveLocal').addEventListener('click', async () => {
    closeAllOverlays();
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      state.pendingBookmarkTabs = [activeTab];
      openFolderPicker(activeTab.title, false, 'local');
    }
  });
  document.getElementById('menuAddCurrentToGroup').addEventListener('click', async () => {
    closeAllOverlays();
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      state.selectedTabIds.clear();
      state.selectedTabIds.add(activeTab.id);
      openGroupPicker();
    }
  });
  document.getElementById('menuSnapshot').addEventListener('click', async () => {
    closeAllOverlays();
    await takeSnapshotAction();
  });
  document.getElementById('menuSettings').addEventListener('click', () => {
    closeAllOverlays();
    openSettingsModal();
  });

  // Settings modal
  document.getElementById('btnTestApi').addEventListener('click', testApiKey);
  document.getElementById('btnSaveSettings').addEventListener('click', saveSettingsAction);
  document.querySelector('#settingsModal .modal-close').addEventListener('click', () => {
    closeModal(document.getElementById('settingsModal'));
  });
  document.querySelector('#settingsModal .modal-backdrop').addEventListener('click', () => {
    closeModal(document.getElementById('settingsModal'));
  });
  document.getElementById('btnBookmarkOpenSettings').addEventListener('click', openSettingsModal);

  // Sync button
  document.getElementById('btnRefreshCollections').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const originHTML = btn.innerHTML;
    btn.innerHTML = 'Syncing...';
    btn.disabled = true;
    await renderBookmarkTree(true);
    btn.innerHTML = originHTML;
    btn.disabled = false;
  });

  // Group picker modal
  document.getElementById('btnNewGroup').addEventListener('click', () => {
    closeModal(document.getElementById('groupPickerModal'));
    openGroupEditModal();
  });
  document.querySelector('#groupPickerModal .modal-close').addEventListener('click', () => {
    closeModal(document.getElementById('groupPickerModal'));
  });
  document.querySelector('#groupPickerModal .modal-backdrop').addEventListener('click', () => {
    closeModal(document.getElementById('groupPickerModal'));
  });

  // Group edit modal
  document.getElementById('btnGroupSave').addEventListener('click', saveGroup);
  document.getElementById('btnGroupCancel').addEventListener('click', () => {
    closeModal(document.getElementById('groupEditModal'));
  });
  document.querySelector('#groupEditModal .modal-close').addEventListener('click', () => {
    closeModal(document.getElementById('groupEditModal'));
  });
  document.querySelector('#groupEditModal .modal-backdrop').addEventListener('click', () => {
    closeModal(document.getElementById('groupEditModal'));
  });
  document.getElementById('groupNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveGroup();
  });

  // Folder picker modal
  document.getElementById('btnSaveToFolder').addEventListener('click', saveToSelectedFolder);
  document.getElementById('btnCreateFolder').addEventListener('click', createSubfolder);
  document.querySelector('#folderPickerModal .modal-close').addEventListener('click', () => {
    closeModal(document.getElementById('folderPickerModal'));
    state.pendingBookmarkTabs = [];
  });
  document.querySelector('#folderPickerModal .modal-backdrop').addEventListener('click', () => {
    closeModal(document.getElementById('folderPickerModal'));
    state.pendingBookmarkTabs = [];
  });

  // Confirm modal
  document.getElementById('btnConfirmOk').addEventListener('click', () => {
    closeModal(document.getElementById('confirmModal'));
    if (confirmCallback) confirmCallback();
    confirmCallback = null;
  });
  document.getElementById('btnConfirmCancel').addEventListener('click', () => {
    closeModal(document.getElementById('confirmModal'));
    confirmCallback = null;
  });
  document.querySelector('#confirmModal .modal-backdrop').addEventListener('click', () => {
    closeModal(document.getElementById('confirmModal'));
    confirmCallback = null;
  });

  // Snapshot empty state button
  document.getElementById('btnSnapshotEmptyCreate').addEventListener('click', async () => {
    await takeSnapshotAction();
  });
}
