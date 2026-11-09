-- Build A (daily report), 6.1: per-property settings the daily report reads
-- instead of its hard-coded property list.
--
-- report_short_name     short name the email uses; the report falls back to
--                       properties.name when it is empty (e.g. 412A until set).
-- price_target_low_pct  market percentile range the property should price in.
-- price_target_high_pct PriceLabs neighborhood data only gives the 25th, 50th,
--                       75th and 90th percentiles, so only those are allowed.
--
-- All three are admin-only: protect_property_admin_columns() is an allowlist
-- of client-editable columns and these are not in it.

alter table public.properties
  add column report_short_name     text,
  add column price_target_low_pct  integer not null default 50,
  add column price_target_high_pct integer not null default 75,
  add constraint properties_price_target_check check (
    price_target_low_pct  in (25, 50, 75, 90) and
    price_target_high_pct in (25, 50, 75, 90) and
    price_target_low_pct < price_target_high_pct);

update public.properties set report_short_name = case id
  when 5 then 'Emerald Views'
  when 6 then 'Enchanted Getaway'
  when 7 then 'Musical Oasis'
  when 8 then 'Travelers Paradise' end
where id in (5, 6, 7, 8);

-- Emerald Views: premium 1BR/2BA, targets the 75th to 90th percentile.
update public.properties set price_target_low_pct = 75, price_target_high_pct = 90
where id = 5;
