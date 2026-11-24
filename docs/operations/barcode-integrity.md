# Barcode integrity

A store reserves each canonical barcode for one catalog row, including archived products and units of the same product. Original spellings remain unchanged. Only a 13-digit, all-numeric EAN beginning with zero is equivalent to its 12-digit UPC spelling. Changing or removing a barcode releases the old reservation transactionally.

Migration 2001 locks the catalog tables during the registry backfill and installs database triggers in the same transaction. Existing conflicting rows are retained and counted in the registry; new reservations for those keys are rejected. A lookup for an unresolved group returns 409 `conflict` rather than choosing a product. Existing rows can be corrected individually; the reservation becomes available when the last row is removed or changed. A migration failure rolls back the backfill and trigger installation; retry the migration after addressing its cause.

The read-only inventory query in [issue #373](https://github.com/datamonsterr/taphoa-mini/issues/373) reports counts of conflicting canonical groups, rows, cross-table groups, UPC aliases, and groups involving archived products. Run it only after production access and operational review. It does not identify winners or change data; investigation and correction of individual groups require separately reviewed access.
