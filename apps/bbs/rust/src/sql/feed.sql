SELECT articles.id, articles.source_article_id, articles.canonical_url AS url, articles.title,
       articles.title_season, articles.title_team, articles.title_topic, coalesce(to_jsonb(articles.title_labels), '[]'::jsonb) AS title_labels,
       articles.author, articles.published_at, articles.discovered_at, articles.fetched_at, articles.is_pinned, articles.introduction,
       coalesce(length(articles.body_text), 0)::int AS body_chars,
       substr(articles.body_text, 1, 800) AS body_head,
       (SELECT coalesce(jsonb_agg(tag ORDER BY position), '[]'::jsonb)
          FROM article_tags WHERE article_id = articles.id) AS tags,
       (SELECT count(*)::int FROM article_links WHERE article_id = articles.id) AS link_count,
       (SELECT count(*)::int FROM article_images WHERE article_id = articles.id) AS image_count,
       article_ai.overview_json ->> 'tldr' AS tldr,
       coalesce(articles.published_at, articles.discovered_at) AS feed_at, articles.listing_position
FROM articles
LEFT JOIN article_ai ON article_ai.article_id = articles.id AND article_ai.status = 'ready'
WHERE articles.status = 'fetched'
