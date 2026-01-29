// tool_migrations.js
// Auto-migration map for entity tool lists
// Applied when entity loads to handle renamed/consolidated tools

/**
 * Tool migration map: oldName (lowercase) -> newName (lowercase)
 *
 * When tools are renamed or consolidated, add entries here.
 * Entities with old tool names will automatically get the new names.
 */
export const TOOL_MIGRATIONS = {
    // Renames
    'showavataroverlay': 'showoverlay',

    // Consolidations: image/video tools → CreateMedia
    'generateimage': 'createmedia',
    'modifyimage': 'createmedia',
    'createavatarvariant': 'createmedia',
    'generatevideo': 'createmedia',

    // Consolidations: file collection tools → FileCollection
    'addfiletocollection': 'filecollection',
    'searchfilecollection': 'filecollection',
    'listfilecollection': 'filecollection',
    'removefilefromcollection': 'filecollection',
    'updatefilemetadata': 'filecollection',
};

/**
 * Migrate an entity's tool list to use current tool names
 *
 * @param {string[]} tools - Entity's tool list (may contain old names)
 * @returns {string[]} - Migrated tool list with current names, deduplicated
 */
export function migrateToolList(tools) {
    if (!tools || !Array.isArray(tools)) return tools;

    // Handle wildcard - no migration needed
    if (tools.includes('*')) return tools;

    const migrated = new Set();
    let changed = false;

    for (const tool of tools) {
        const normalizedTool = tool.toLowerCase();
        const newTool = TOOL_MIGRATIONS[normalizedTool];

        if (newTool) {
            migrated.add(newTool);
            changed = true;
        } else {
            migrated.add(normalizedTool);
        }
    }

    // Return original case-normalized array if no migrations applied
    // Return deduplicated array if migrations were applied
    return changed ? [...migrated] : tools.map(t => t.toLowerCase());
}

/**
 * Check if a tool list needs migration
 *
 * @param {string[]} tools - Entity's tool list
 * @returns {boolean} - True if any tools need migration
 */
export function needsMigration(tools) {
    if (!tools || !Array.isArray(tools) || tools.includes('*')) return false;

    return tools.some(tool => TOOL_MIGRATIONS[tool.toLowerCase()]);
}
