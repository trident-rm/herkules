SELECT articles.id, source_article_id, canonical_url AS url, title,
       title_season, title_team, title_topic, coalesce(to_jsonb(title_labels), '[]'::jsonb) AS title_labels,
       author, published_at, discovered_at, fetched_at, is_pinned, introduction,
       coalesce(length(body_text), 0)::int AS body_chars,
       substr(body_text, 1, 800) AS body_head,
       (SELECT coalesce(jsonb_agg(tag ORDER BY position), '[]'::jsonb)
          FROM article_tags WHERE article_id = articles.id) AS tags,
       (SELECT count(*)::int FROM article_links WHERE article_id = articles.id) AS link_count,
       (SELECT count(*)::int FROM article_images WHERE article_id = articles.id) AS image_count,
       article_ai.overview_json ->> 'tldr' AS tldr,
       content_format, content_html, body_text,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
           'url', l.url, 'kind', l.kind,
           'label', coalesce(nullif(l.label, ''), target.title),
           'articleId', CASE WHEN target.status = 'fetched' THEN target.id END,
           'position', l.position) ORDER BY l.position), '[]'::jsonb)
          FROM article_links l LEFT JOIN articles target ON target.id = l.target_article_id
          WHERE l.article_id = articles.id) AS links,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
           'url', url, 'alt', coalesce(nullif(alt, ''), caption), 'position', position)
           ORDER BY position), '[]'::jsonb)
          FROM article_images WHERE article_id = articles.id) AS images
FROM articles
LEFT JOIN article_ai ON article_ai.article_id = articles.id AND article_ai.status = 'ready'
WHERE articles.id = $1 AND articles.status = 'fetched'
