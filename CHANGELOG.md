# Changelog

## 0.2.0
### Embed support (full rewrite)
- Collapse/expand groups in embedded `.base` files within markdown notes
- Expanded groups show rows immediately with no whitespace gaps — groups are repacked using actual rendered heights after every virtual display update
- Collapsed groups compact to header-only height, matching native Bases appearance
- Fold state persists across reloads for embedded views
- Toolbar (Collapse All / Expand All) works in embeds
- Group count badges work in embeds
- Canvas node embeds supported

### Bug fixes
- Fixed group gap: removed 10px gap introduced between groups by virtual renderer patch
- Fixed click handling in embeds for groups outside initial viewport
- Fixed stale fold state keys accumulating from fallback `_stateKey` path

## 0.1.0
- Initial release
