-- Full-text search over catalog titles (ADR 0002 §6). Maintained by the Catalog module in the same transaction.
CREATE VIRTUAL TABLE `catalog_search` USING fts5(
  item_id UNINDEXED,
  title,
  original_title,
  tokenize = 'unicode61 remove_diacritics 2'
);
