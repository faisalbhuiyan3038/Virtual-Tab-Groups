/**
 * Virtual Tab Groups — Raindrop.io API Client
 * Handles authentication and requests to api.raindrop.io
 */

import { getSettings } from './storage.js';

const API_BASE = 'https://api.raindrop.io/rest/v1';

async function fetchApi(endpoint, options = {}) {
  const settings = await getSettings();
  const token = settings.raindropApiKey;
  
  if (!token) {
    throw new Error('NO_API_KEY');
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    ...options.headers,
  };

  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = `API Error: ${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      message = data.errorMessage || data.error || message;
    } catch (e) {
      // Ignored
    }
    
    // Status 401 usually means invalid token
    if (response.status === 401) {
      throw new Error('INVALID_API_KEY');
    }
    throw new Error(message);
  }

  return response.json();
}

/**
 * Get all root collections
 */
export async function getRootCollections() {
  const data = await fetchApi('/collections');
  return data.items || [];
}

/**
 * Get all child collections
 */
export async function getChildCollections() {
  const data = await fetchApi('/collections/childrens');
  return data.items || [];
}

/**
 * Check API Token by fetching user profile
 */
export async function checkAuth() {
  const data = await fetchApi('/user');
  return data.user;
}

/**
 * Create a new collection
 * @param {string} title - Name of the collection
 * @param {number|null} parentId - Optional ID of parent collection
 */
export async function createCollection(title, parentId = null) {
  const body = { title };
  if (parentId) {
    body.parent = { $id: parentId };
  }
  const data = await fetchApi('/collection', {
    method: 'POST',
    body,
  });
  return data.item;
}

/**
 * Save multiple tabs as bookmarks (raindrops)
 * @param {Array} tabs - Array of { url, title } objects
 * @param {number} collectionId - ID of destination collection
 */
export async function saveBookmarks(tabs, collectionId) {
  // Raindrop allows bulk create via /raindrops (note the plural)
  const raindrops = tabs.map(tab => ({
    link: tab.url,
    title: tab.title || tab.url,
    collection: { $id: collectionId },
    pleaseParse: { weight: 1 } // Tells Raindrop to fetch metadata/thumbnails
  }));

  const data = await fetchApi('/raindrops', {
    method: 'POST',
    body: { items: raindrops },
  });

  // Returns array of created items
  return data.items || [];
}

/**
 * Get raindrops for a collection
 */
export async function getBookmarks(collectionId) {
  const data = await fetchApi(`/raindrops/${collectionId}`);
  return data.items || [];
}
