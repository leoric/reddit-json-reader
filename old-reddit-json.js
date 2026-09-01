// ==UserScript==
// @name         Reddit: Old-style JSON Reader
// @namespace    https://leoric.local/userscripts
// @version      1.0.0
// @description  Re-renders www.reddit.com from the .json API in an old-reddit-style layout, but keeps images/video at new-reddit size
// @author       leoric
// @match        https://www.reddit.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------- escape hatch ----------
  // Visit any page with ?orr=off appended to skip this script entirely
  // and see the normal reddit.com page (the header link below adds this).
  const params = new URLSearchParams(location.search);
  if (params.get('orr') === 'off') return;

  const PATH = location.pathname;

  // ---------- routing: decide whether to touch this page at all ----------
  const isComments = /^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(PATH);
  const EXCLUDED_RE =
    /^\/(login|register|settings|message|chat|submit|notifications|premium|gold|coins|avatar|live|broadcast|poll|community-points|appeal|report|policies|contact|dev|prefs|api)(\/|$)/i;
  const isExcluded =
    EXCLUDED_RE.test(PATH) || /\/(wiki|w)(\/|$)/i.test(PATH);

  if (!isComments && isExcluded) return; // let native reddit handle it

  // ---------- stop reddit's own SPA router from swallowing our clicks ----------
  // The native react app keeps loading in the background even though it's
  // hidden. It listens for clicks on the whole document to do client-side
  // navigation instead of a real page load, which makes our links look dead.
  // Registering on `window` with capture:true at document-start guarantees
  // we run before its `document`-level listener, regardless of load order,
  // because window is structurally above document in the capture phase.
  window.addEventListener('click', function (e) {
    const root = document.getElementById('orr-root');
    if (!root) return;
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || !root.contains(a)) return;
    e.stopImmediatePropagation();
    if (a.target === '_blank') return; // let the browser open the new tab normally
    e.preventDefault();
    location.assign(a.href);
  }, true);

  // ---------- hide the native page ASAP to avoid a flash of new-reddit UI ----------
  const hideStyle = document.createElement('style');
  hideStyle.id = 'orr-hide';
  hideStyle.textContent = `body > :not(#orr-root){ display:none !important; }`;
  document.documentElement.appendChild(hideStyle);

  function whenBodyReady() {
    return new Promise((resolve) => {
      if (document.body) return resolve();
      const obs = new MutationObserver(() => {
        if (document.body) {
          obs.disconnect();
          resolve();
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // ---------- fetch the json ----------
  function jsonUrl() {
    const base = PATH === '/' ? '/.json' : PATH.replace(/\/$/, '') + '.json';
    const sep = location.search ? '&' : '?';
    return location.origin + base + location.search + sep + 'raw_json=1';
  }

  function fetchJson() {
    return fetch(jsonUrl(), { credentials: 'same-origin' }).then((r) => {
      if (!r.ok) throw new Error('reddit json fetch failed: ' + r.status);
      return r.json();
    });
  }

  // ---------- small helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function decodeHtml(html) {
    const ta = document.createElement('textarea');
    ta.innerHTML = html || '';
    return ta.value;
  }
  function unescAmp(u) {
    return u ? String(u).replace(/&amp;/g, '&') : u;
  }
  function formatScore(n) {
    if (n == null) return '\u2022';
    const abs = Math.abs(n);
    if (abs >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (abs >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function formatAgo(unix) {
    if (!unix) return '';
    const s = Math.max(1, Math.floor(Date.now() / 1000 - unix));
    const units = [
      ['y', 31536000], ['mo', 2592000], ['d', 86400],
      ['h', 3600], ['m', 60], ['s', 1],
    ];
    for (const [label, secs] of units) {
      if (s >= secs) return Math.floor(s / secs) + label + ' ago';
    }
    return 'just now';
  }
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  function stripSort(p) {
    return p.replace(/\/(hot|new|top|rising|controversial|best)\/?$/i, '') || '/';
  }

  // ---------- media rendering (kept at "new reddit" size) ----------
  function bestPreviewUrl(previewImages, targetWidth) {
    if (!previewImages || !previewImages.length) return null;
    const img = previewImages[0];
    const candidates = (img.resolutions || []).concat([img.source]);
    let best = candidates[candidates.length - 1];
    for (const c of candidates) {
      if (c && c.width >= targetWidth) { best = c; break; }
    }
    return best ? unescAmp(best.url) : null;
  }

  function renderMedia(post) {
    const src = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;
    const wrap = el('div', { class: 'orr-media' });

    if (src.is_gallery && src.gallery_data && src.media_metadata) {
      const grid = el('div', { class: 'orr-gallery' });
      for (const item of src.gallery_data.items) {
        const m = src.media_metadata[item.media_id];
        if (!m) continue;
        const url = unescAmp((m.s && (m.s.u || m.s.gif || m.s.mp4)) || '');
        if (!url) continue;
        grid.appendChild(el('img', { src: url, loading: 'lazy', class: 'orr-gallery-img' }));
      }
      wrap.appendChild(grid);
      return wrap;
    }

    if (src.is_video && src.media && src.media.reddit_video) {
      const v = src.media.reddit_video;
      const video = el('video', {
        controls: 'controls',
        preload: 'metadata',
        class: 'orr-video',
        poster: bestPreviewUrl(src.preview && src.preview.images, 640) || '',
      });
      video.src = unescAmp(v.fallback_url);
      wrap.appendChild(video);
      wrap.appendChild(el('div', { class: 'orr-note' }, 'reddit-hosted video: audio track omitted (fallback stream is video-only)'));
      return wrap;
    }

    if (src.media && src.media.oembed && src.media.oembed.html) {
      const box = el('div', { class: 'orr-embed', html: decodeHtml(src.media.oembed.html) });
      wrap.appendChild(box);
      return wrap;
    }

    const previewUrl = bestPreviewUrl(src.preview && src.preview.images, 640);
    if (previewUrl) {
      wrap.appendChild(el('img', { src: previewUrl, loading: 'lazy', class: 'orr-img' }));
      return wrap;
    }

    if (src.thumbnail && /^https?:\/\//.test(src.thumbnail)) {
      wrap.appendChild(el('img', { src: unescAmp(src.thumbnail), loading: 'lazy', class: 'orr-thumb' }));
      return wrap;
    }

    return null;
  }

  // ---------- listing (subreddit / home / user / domain / multi) ----------
  function renderPostRow(post) {
    const row = el('div', { class: 'orr-row' });
    const voteCol = el('div', { class: 'orr-votecol' },
      el('div', { class: 'orr-score' }, formatScore(post.score)));
    const body = el('div', { class: 'orr-body' });

    const titleLink = el('a', {
      class: 'orr-title',
      href: post.is_self ? ('https://www.reddit.com' + post.permalink) : post.url,
      target: post.is_self ? '_self' : '_blank',
      rel: 'noopener noreferrer',
    }, post.title + (post.link_flair_text ? '' : ''));
    if (post.link_flair_text) {
      body.appendChild(el('span', { class: 'orr-flair' }, post.link_flair_text));
    }
    body.appendChild(titleLink);
    if (!post.is_self) {
      body.appendChild(el('span', { class: 'orr-domain' }, ' (' + post.domain + ')'));
    }
    if (post.over_18) body.appendChild(el('span', { class: 'orr-nsfw' }, 'NSFW'));

    const meta = el('div', { class: 'orr-meta' },
      'submitted ' + formatAgo(post.created_utc) + ' by ',
      el('a', { href: 'https://www.reddit.com/user/' + post.author, class: 'orr-user' }, post.author),
      ' to ',
      el('a', { href: 'https://www.reddit.com/r/' + post.subreddit, class: 'orr-sub' }, 'r/' + post.subreddit),
      '  |  ',
      el('a', { href: 'https://www.reddit.com' + post.permalink, class: 'orr-comments' },
        (post.num_comments != null ? post.num_comments : 0) + ' comments')
    );

    body.appendChild(meta);
    const media = renderMedia(post);
    if (media) body.appendChild(media);

    row.appendChild(voteCol);
    row.appendChild(body);
    return row;
  }

  function renderCommentRowFlat(c) {
    // used on user overview / search pages where items can be t1 comments
    const row = el('div', { class: 'orr-row orr-commentrow' });
    row.appendChild(el('div', { class: 'orr-votecol' }, el('div', { class: 'orr-score' }, formatScore(c.score))));
    const body = el('div', { class: 'orr-body' });
    body.appendChild(el('div', { class: 'orr-comment-context' },
      'comment by ',
      el('a', { href: 'https://www.reddit.com/user/' + c.author }, c.author),
      ' on ',
      el('a', { href: 'https://www.reddit.com' + (c.link_permalink || c.permalink || '') }, c.link_title || '(thread)')
    ));
    body.appendChild(el('div', { class: 'orr-comment-body', html: decodeHtml(c.body_html || '') }));
    row.appendChild(body);
    return row;
  }

  function renderListing(data, root) {
    const children = (data.data && data.data.children) || [];
    root.appendChild(headerBar(true));
    const list = el('div', { class: 'orr-list' });
    for (const child of children) {
      if (child.kind === 't3') list.appendChild(renderPostRow(child.data));
      else if (child.kind === 't1') list.appendChild(renderCommentRowFlat(child.data));
    }
    root.appendChild(list);

    if (data.data && data.data.after) {
      const nextUrl = new URL(location.href);
      nextUrl.searchParams.set('after', data.data.after);
      root.appendChild(el('div', { class: 'orr-nav' },
        el('a', { href: nextUrl.pathname + nextUrl.search, class: 'orr-next' }, 'next \u203a')));
    }
  }

  // ---------- comments page ----------
  function renderComment(node, depth, postPermalink) {
    const indent = depth > 0 ? '16px' : '0';
    if (node.kind === 'more') {
      if (!node.data || node.data.count === 0) return null;
      const parentId = (node.data.parent_id || '').replace(/^t1_/, '');
      const href = 'https://www.reddit.com' + postPermalink + parentId + '/';
      return el('div', { class: 'orr-more', style: 'margin-left:' + indent },
        el('a', { href, class: 'orr-more-link' }, node.data.count + ' more replies'));
    }
    if (node.kind !== 't1') return null;
    const c = node.data;
    const wrap = el('div', { class: 'orr-comment', style: 'margin-left:' + indent });
    const head = el('div', {
      class: 'orr-comment-head',
      onclick: () => wrap.classList.toggle('orr-collapsed'),
    },
      el('span', { class: 'orr-collapse-toggle' }, '[\u2013] '),
      el('a', { href: 'https://www.reddit.com/user/' + c.author, class: 'orr-user' }, c.author),
      ' ',
      el('span', { class: 'orr-score' }, formatScore(c.score) + ' points'),
      ' ',
      el('span', { class: 'orr-time' }, formatAgo(c.created_utc))
    );
    const bodyDiv = el('div', { class: 'orr-comment-body', html: decodeHtml(c.body_html || '[removed]') });
    wrap.appendChild(head);
    wrap.appendChild(bodyDiv);

    if (c.replies && c.replies.data && c.replies.data.children) {
      const kids = el('div', { class: 'orr-comment-children' });
      for (const child of c.replies.data.children) {
        const r = renderComment(child, depth + 1, postPermalink);
        if (r) kids.appendChild(r);
      }
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function renderCommentsPage(data, root) {
    const post = data[0].data.children[0].data;
    root.appendChild(headerBar(false));

    const postBox = el('div', { class: 'orr-postbox' });
    postBox.appendChild(el('div', { class: 'orr-votecol' }, el('div', { class: 'orr-score' }, formatScore(post.score))));
    const pbody = el('div', { class: 'orr-body' });
    pbody.appendChild(el('a', {
      class: 'orr-title orr-title-big',
      href: post.is_self ? ('https://www.reddit.com' + post.permalink) : post.url,
      target: post.is_self ? '_self' : '_blank',
      rel: 'noopener noreferrer',
    }, post.title));
    if (!post.is_self) pbody.appendChild(el('span', { class: 'orr-domain' }, ' (' + post.domain + ')'));
    pbody.appendChild(el('div', { class: 'orr-meta' },
      'submitted ' + formatAgo(post.created_utc) + ' by ',
      el('a', { href: 'https://www.reddit.com/user/' + post.author, class: 'orr-user' }, post.author),
      ' to ',
      el('a', { href: 'https://www.reddit.com/r/' + post.subreddit, class: 'orr-sub' }, 'r/' + post.subreddit)
    ));
    const media = renderMedia(post);
    if (media) pbody.appendChild(media);
    if (post.is_self && post.selftext_html) {
      pbody.appendChild(el('div', { class: 'orr-selftext', html: decodeHtml(post.selftext_html) }));
    }
    postBox.appendChild(pbody);
    root.appendChild(postBox);

    root.appendChild(el('div', { class: 'orr-comments-count' }, (post.num_comments || 0) + ' comments'));

    const commentsList = el('div', { class: 'orr-comments-list' });
    const topChildren = (data[1].data && data[1].data.children) || [];
    for (const child of topChildren) {
      const r = renderComment(child, 0, post.permalink);
      if (r) commentsList.appendChild(r);
    }
    root.appendChild(commentsList);
  }

  // ---------- header / sort bar ----------
  function headerBar(withSort) {
    const bar = el('div', { class: 'orr-header' });
    bar.appendChild(el('a', { href: 'https://www.reddit.com/', class: 'orr-brand' }, 'reddit'));

    if (withSort) {
      const base = stripSort(PATH);
      const sorts = ['hot', 'new', 'rising', 'top', 'controversial', 'best'];
      const currentSort = (PATH.match(/\/(hot|new|top|rising|controversial|best)\/?$/i) || [, 'hot'])[1].toLowerCase();
      const tabs = el('div', { class: 'orr-tabs' });
      for (const s of sorts) {
        const href = (base === '/' ? '' : base) + '/' + s;
        tabs.appendChild(el('a', {
          href,
          class: 'orr-tab' + (s === currentSort ? ' orr-tab-active' : ''),
        }, s));
      }
      bar.appendChild(tabs);
    } else {
      const subMatch = PATH.match(/^\/r\/([^/]+)/);
      if (subMatch) {
        bar.appendChild(el('a', { href: 'https://www.reddit.com/r/' + subMatch[1], class: 'orr-tab' }, 'back to r/' + subMatch[1]));
      }
    }

    const escapeUrl = new URL(location.href);
    escapeUrl.searchParams.set('orr', 'off');
    bar.appendChild(el('a', { href: escapeUrl.pathname + escapeUrl.search, class: 'orr-escape' }, 'view original reddit.com'));
    return bar;
  }

  // ---------- CSS ----------
  function injectCss() {
    const css = `
      #orr-root { all: initial; display:block; font: 13px/1.4 Verdana, Arial, sans-serif; color:#1c1c1c; background:#fff; max-width: 1024px; margin: 0 auto; }
      #orr-root * { box-sizing: border-box; font-family: inherit; }
      #orr-root a { color:#0b6b9c; text-decoration:none; }
      #orr-root a:hover { text-decoration:underline; }
      .orr-header { display:flex; align-items:center; gap:16px; background:#ff4500; padding:8px 12px; }
      .orr-brand { color:#fff !important; font-weight:bold; font-size:18px; letter-spacing:-0.5px; }
      .orr-tabs { display:flex; gap:10px; }
      .orr-tab, .orr-tabs a { color:#fff !important; opacity:0.85; text-transform:capitalize; }
      .orr-tab-active { opacity:1; font-weight:bold; text-decoration:underline; }
      .orr-escape { margin-left:auto; color:#fff !important; opacity:0.75; font-size:11px; }
      .orr-list { border-top:1px solid #edeff1; }
      .orr-row { display:flex; gap:10px; padding:10px 12px; border-bottom:1px solid #edeff1; }
      .orr-row:hover { background:#f8f9fa; }
      .orr-votecol { width:40px; flex:0 0 40px; text-align:center; padding-top:2px; }
      .orr-score { color:#878a8c; font-weight:bold; font-size:12px; }
      .orr-body { flex:1; min-width:0; }
      .orr-title { font-size:16px; color:#222; }
      .orr-title-big { font-size:20px; }
      .orr-domain { color:#888; font-size:12px; margin-left:4px; }
      .orr-flair { display:inline-block; background:#eef6ff; color:#369; border-radius:3px; padding:1px 5px; font-size:11px; margin-right:6px; }
      .orr-nsfw { color:#e5001c; border:1px solid #e5001c; font-size:10px; padding:0 3px; margin-left:6px; border-radius:2px; }
      .orr-meta { color:#888; font-size:11.5px; margin-top:3px; }
      .orr-meta a { color:#888 !important; }
      .orr-comments { color:#0b6b9c !important; }
      .orr-media { margin-top:8px; }
      .orr-img, .orr-video { max-width: 640px; width:100%; height:auto; border-radius:3px; display:block; }
      .orr-thumb { max-width:200px; border-radius:3px; display:block; }
      .orr-gallery { display:flex; flex-wrap:wrap; gap:6px; }
      .orr-gallery-img { max-width:300px; max-height:300px; border-radius:3px; }
      .orr-embed { max-width:640px; }
      .orr-embed iframe { max-width:100%; }
      .orr-note { color:#aaa; font-size:11px; margin-top:2px; }
      .orr-nav { padding:14px; text-align:center; }
      .orr-postbox { display:flex; gap:10px; padding:14px 12px; border-bottom:2px solid #ff4500; }
      .orr-selftext { margin-top:10px; padding:10px; background:#f8f9fa; border:1px solid #edeff1; border-radius:4px; max-width:720px; }
      .orr-selftext p { margin:0 0 10px; }
      .orr-comments-count { padding:10px 12px; color:#555; font-weight:bold; border-bottom:1px solid #edeff1; }
      .orr-comments-list { padding:10px 12px; }
      .orr-comment { border-left:2px solid #edeff1; padding-left:10px; margin-top:10px; }
      .orr-comment-head { cursor:pointer; color:#888; font-size:11.5px; user-select:none; }
      .orr-comment-head .orr-user { color:#336699 !important; font-weight:bold; }
      .orr-comment-body { margin:4px 0 2px; }
      .orr-comment-body p { margin:0 0 8px; }
      .orr-collapsed .orr-comment-body, .orr-collapsed .orr-comment-children { display:none; }
      .orr-more { color:#888; font-size:12px; margin-top:6px; }
      .orr-more-link { color:#888 !important; }
      .orr-commentrow .orr-comment-context { color:#888; font-size:11.5px; margin-bottom:4px; }
    `;
    document.documentElement.appendChild(el('style', { html: css }));
  }

  // ---------- boot ----------
  Promise.all([fetchJson(), whenBodyReady()])
    .then(([data]) => {
      injectCss();
      const root = el('div', { id: 'orr-root' });
      document.body.appendChild(root);
      if (Array.isArray(data)) renderCommentsPage(data, root);
      else renderListing(data, root);
    })
    .catch((err) => {
      // on failure, fall back to the normal reddit page instead of a blank hidden screen
      console.error('[old-reddit-json-reader]', err);
      hideStyle.remove();
    });
})();
