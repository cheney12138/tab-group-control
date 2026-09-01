# Tab Group Search

A Chrome extension for managing large numbers of tabs in multi-environment development workflows: **search & switch + automatic tab grouping**, in one place.

## Overview

### 🔍 Search & Switch

- **Tiered matching**: title > pinyin > group name > domain > full URL. Exact substring matches rank above fuzzy ones, with matched characters highlighted
- **Full pinyin matching**: `dingdan` → 「订单管理」, `djtx` (initials) also hits. Powered by a built-in Unicode codepoint-indexed table covering 20,924 CJK characters — no runtime encoding conversion, zero dependencies
- **Exact group name boost**: when the query exactly equals a group name, that group is pinned to the top
- **Command modes**: `/b` searches bookmarks, `/h` searches history (Chrome's native time ordering, same-URL collapsed). Or click the 🔗 / 🕐 buttons inside the search box
- **Duplicate merging**: multiple tabs with the same URL collapse into one row with a count badge on the favicon; `⌘⌫` removes duplicates one at a time
- **Three views** (cycle with `Tab`): Grouped (collapsible sections) / Recently Used / Current Window

### 🗂 Automatic Tab Grouping

- **Domain rule engine**: each group is bound to a list of domains; new tabs and in-page navigations are grouped automatically
- **Same-name group reuse**: before creating a group, existing same-name groups are looked up first — no duplicate group accumulation
- **Others fallback**: tabs matching no rule go into an `Others` group, so the tab bar stays organized
- **Rule editor**: chip-style editing in the settings panel (group name + domain chips), saved rules take effect immediately, with unsaved-change indication
- **Master switch**: enable/disable at will; enabling triggers an immediate re-grouping of existing tabs. Predictable behavior, no silent failures
- **Auto-collapse groups**: switching tabs collapses all other groups in the window — only the active group stays expanded

### ⌨️ More

- **Go to previous tab** (`⌥E`): MRU-stack based A↔B toggling, falls back to earlier entries when the target has been closed
- **Time tier tags**: current / 10 min (green) / 24 h (blue) / 7 d (grey) / 30 d (amber) / older (red)
- **Stale tab cleanup** (`⌘⇧K`): close all tabs unused for 7+ days in one shot, undoable
- **Undo**: closed tabs can be restored with `⌘Z` within 6 seconds — back to their original groups, with browsing history intact
- **Performance**: event-driven worker keep-alive + tab snapshot (popup renders instantly), favicons served from Chrome's built-in cache
- **Dark mode**: follows the system

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘E` | Open the popup (global, customizable via Chrome's shortcuts page) |
| `⌥E` | Go to previous tab (A/B toggle) |
| `↑ ↓` | Navigate (across groups, including group headers) |
| `→ / ←` | Collapse / expand group |
| `Tab` | Cycle views: Grouped / Recent / Current Window |
| `Enter` | Switch to the selected tab |
| `⌘C` | Copy the selected tab's URL |
| `⌘⌫` | Delete selection (removes duplicates one at a time when present, otherwise closes the tab) |
| `⌘Z` | Undo last close |
| `⌘⇧K` | Clean up tabs unused for 7+ days |
| `Esc` | Layered exit: close settings → clear query → close popup |

On Windows, `⌘` maps to `Ctrl`.

## Installation (Developer Mode)

1. Download this repository
2. Open `chrome://extensions/` and enable **Developer mode** (top right)
3. Click **Load unpacked** and select the project directory
4. Open `chrome://extensions/shortcuts` to confirm key bindings (`⌘E` for popup, `⌥E` for previous tab)

## Known Limitations

- **Saved tab groups cannot be managed by extensions**: saved-but-not-open groups shown on the bookmarks bar are outside every extension API (`tabGroups` only covers open groups; they don't exist in the `bookmarks` tree either). They must be removed manually
- **Polyphonic characters use the common reading**: 「重」 → zhong (chong as in Chongqing won't match); initial-letter and raw-text matching serve as fallbacks
- **Auto-collapse is fully managed**: manually expanded groups get collapsed again when you switch tabs (think of it as peek-then-auto-close)
- **MV3 worker idle**: the first invocation after a long idle may have slight latency (event-driven keep-alive covers most cases); a second press recovers instantly

## Tech

Plain JavaScript + DOM, no frameworks, no dependencies. Manifest V3.
Permissions: `tabs` / `tabGroups` / `sessions` / `favicon` / `bookmarks` / `history` / `storage`.
