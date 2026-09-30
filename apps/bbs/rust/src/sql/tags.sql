WITH t AS (
    SELECT tag, group_name, article_id FROM article_tags
    JOIN articles ON articles.id = article_id AND articles.status = 'fetched'
)
SELECT
    (SELECT coalesce(jsonb_agg(x ORDER BY x.count DESC, x.name ASC), '[]'::jsonb)
       FROM (SELECT tag AS name, count(*)::int AS count FROM t GROUP BY tag) x) AS items,
    (SELECT coalesce(jsonb_agg(x ORDER BY x.count DESC, x.name ASC), '[]'::jsonb)
       FROM (SELECT group_name AS name, count(DISTINCT article_id)::int AS count FROM t GROUP BY group_name) x) AS groups,
    (SELECT count(*)::int FROM articles WHERE status = 'fetched') AS total

