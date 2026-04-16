# Changelog

## 0.1.5
- Fixed first column text overflowing into adjacent columns in grouped Bases views — the drag cell's `position: relative` broke Obsidian's absolute-positioned column layout

## 0.1.4
- Fixed drag handle alignment and spacing issues in direct Bases views when the first grouped column is a metadata field instead of `file.name`
- Fixed delayed drag handle rendering in embedded Bases views while scrolling through virtualized rows
- Fixed drag and drop targeting so group headers, including collapsed groups in canvas views, can receive dropped rows

## 0.1.3
- Added drag and drop between groups in grouped Bases views, including press-and-hold activation on mobile
- Improved stability across direct views, embeds, canvas views, settings changes, sorting, and grouped field refresh behavior
- Fixed a filtering bug in embedded Bases views that could leave stale gaps or incorrect group counts after filters changed

## 0.1.2
- Added drag and drop to move rows between groups in grouped Bases views

## 0.1.1
- Added support for grouping in embedding bases with grouping features into markdown files an canvas files
- Multiple bug fixes

## 0.1.0
- Initial release
