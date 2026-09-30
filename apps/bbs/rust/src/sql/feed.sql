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
       coalesce(articles.published_at, articles.discovered_at) AS feed_at, listing_position
FROM articles
LEFT JOIN article_ai ON article_ai.article_id = articles.id AND article_ai.status = 'ready'
WHERE articles.status = 'fetched'
