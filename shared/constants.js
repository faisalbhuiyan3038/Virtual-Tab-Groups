/**
 * Virtual Tab Groups — Constants
 */

export const GROUP_COLORS = [
  { id: 'indigo',  hex: '#6366F1', label: 'Indigo'  },
  { id: 'violet',  hex: '#8B5CF6', label: 'Violet'  },
  { id: 'rose',    hex: '#F43F5E', label: 'Rose'    },
  { id: 'amber',   hex: '#F59E0B', label: 'Amber'   },
  { id: 'emerald', hex: '#10B981', label: 'Emerald' },
  { id: 'cyan',    hex: '#06B6D4', label: 'Cyan'    },
  { id: 'sky',     hex: '#0EA5E9', label: 'Sky'     },
  { id: 'slate',   hex: '#64748B', label: 'Slate'   },
];

export const DEFAULT_SETTINGS = {
  theme: 'auto',               // 'auto' | 'dark' | 'light'
  defaultSaveAction: 'keep',   // 'keep' | 'close' — after saving to bookmarks
  confirmClose: true,
  snapshotOnExit: false,
};

export const STORAGE_KEYS = {
  GROUPS: 'vtg_groups',
  SETTINGS: 'vtg_settings',
  SNAPSHOTS: 'vtg_snapshots',
  SCHEMA_VERSION: 'vtg_schema_version',
};

export const CURRENT_SCHEMA_VERSION = 1;

export const UNGROUPED_ID = '__ungrouped__';
