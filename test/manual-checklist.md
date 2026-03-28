# Manual Hardening Checklist

## Direct Views

- Open `Sample 1.base` and verify grouped headers, counts, toolbar, and drag handles render correctly.
- Toggle collapsible groups off and verify chevrons disappear while drag handles still remain when drag is enabled.
- Edit a grouped property inline and verify the row updates in the UI without reopening the base.
- Change sort order and verify rows re-order correctly within groups.
- Drag a row to another group and back.

## Embedded Views

- Open a markdown note with an embedded grouped Bases view.
- Verify toolbar, counts, collapse UI, and drag handles appear when enabled.
- Verify drag still works after scrolling the markdown view.
- Toggle drag off and verify handles disappear without affecting other enabled features.

## Canvas Views

- Open a canvas containing a grouped Bases node.
- Verify collapse controls, counts, and drag handles render correctly.
- Drag a row to another group and confirm the row move persists.
- Toggle collapse off and verify drag remains available when enabled.

## Mobile and Settings

- In mobile mode, verify mobile-specific toggles override desktop settings only when the desktop feature is enabled.
- Verify mobile drag requires press and hold to activate.
- Verify the restart notice card appears at the top of plugin settings.
- Change several settings, reload the plugin, and confirm the UI stays consistent.

## Final Release Checks

- Run `npm test`.
- Run `npm run build`.
- Deploy to `TestingVault` and confirm the updated build loads.
- Deploy to `nexus` and confirm the updated build loads.
