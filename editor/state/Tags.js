/**
 * Project-wide object tag registry used by the Inspector and script
 * autocomplete. The tag stored on an entity remains part of the scene data;
 * this registry only remembers which tags are available to choose later.
 *
 * EDITOR-ONLY FILE.
 */

const STORAGE_KEY = "zenengine_object_tags";
const DEFAULT_TAGS = ["Untagged", "Player", "Enemy"];
let _sessionCache = null;

function _defaults() {
  return DEFAULT_TAGS.slice();
}

export function getTagNames() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const names = parsed.filter((tag) => typeof tag === "string" && tag.trim());
        return [...new Set(["Untagged", ...names])];
      }
    }
  } catch (_) {
    // Keep the in-memory registry usable in restricted preview frames.
  }
  return _sessionCache ? _sessionCache.slice() : _defaults();
}

export function addTag(tag) {
  const name = String(tag == null ? "" : tag).trim();
  if (!name) return null;
  const names = getTagNames();
  if (!names.includes(name)) names.push(name);
  _sessionCache = names;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch (_) {}
  return name;
}

/**
 * Remove a custom tag from the project tag list.
 * "Untagged" cannot be removed. Entities that already have this tag
 * keep their current tag value — it just disappears from the dropdown.
 * @param {string} tag
 */
export function deleteTag(tag) {
  const name = String(tag == null ? "" : tag).trim();
  if (!name || name === "Untagged") return;
  const names = getTagNames().filter((t) => t !== name);
  _sessionCache = names;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch (_) {}
}
