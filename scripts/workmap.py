#!/usr/bin/env python3
"""workmap - project work map: Epic → Feature → Task → Subtask, each with a stable id, a status and an owner.

Installed into your project by the workmap skill. You may use and modify this file freely inside your
project (see the skill's LICENSE.txt, "Installed files"). Standard library only; no network access.

Source:  docs/shared/workmap.md - a markdown outline (one list item per node), the single source of truth.
         A legacy docs/shared/workmap.json is converted to workmap.md the first time the script runs.
Also:    docs/tasks/T-*.md if present (title, status and owner of attached task files).
Output:  docs/workmap.html - the data is embedded, so the page also opens from file://.

  python3 scripts/workmap.py                                  regenerate docs/workmap.html from workmap.md
  python3 scripts/workmap.py show [path|id] [-d N] [-s doing]  outline with ids, owners and status (few tokens);
                                                              -s keeps only branches containing that status
  python3 scripts/workmap.py find "<text>"                    search name / note / id / owner / task → "<icon> <id>  <path>"
  python3 scripts/workmap.py add  "<parent path|id>" "<Name>" [-s doing] [-o owner] [-t T-012] [-n "note"]
        add a child node and print its new id; missing path segments are created. "-t T-012" attaches a
        task file (name, status and owner are read from docs/tasks). A duplicate name or task under the
        same parent is refused.
  python3 scripts/workmap.py set  "<path|id>" <pending|doing|pause|cancel|done|auto> [-o owner] [-n "note"]
        change a status ("auto" removes a hand-set status so it is computed from the children again);
        -o records who is doing the work (an agent name or a person; -o "" clears it)

workmap.md format (see references/workmap.md in the skill):
  ---
  lang: en
  ---
  # Project title
  One-line note shown under the title.

  - `1` Platform & Core API @platform-lead
    - `P1` Authentication Service @backend-agent
      - [x] `T1` OAuth sign-in flow @backend-agent (2026-10-28) — Google and GitHub providers
      - [>] `T2` Session token refresh @backend-agent (2026-11-05)
      - [-] `T3` Magic link sign-in (2026-11-03) — dropped
      - [ ] `T4` Role-based permissions
      - `T5` task:T-012                           ← attached task file: name, status, owner from docs/tasks

  Status markers: [ ] pending · [>] in progress · [=] paused · [-] cancelled · [x] done · no marker = computed
  from the children (a leaf without a marker is pending). Ids in backticks are assigned by the script and
  never change. Tokens after the name: @owner, (YYYY-MM-DD) last update, task:T-012, level:<level>;
  a note follows " — ". Nesting = indentation (any consistent step).
"""
import argparse
import datetime
import glob
import json
import os
import pathlib
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "shared", "workmap.md")
LEGACY = os.path.join(ROOT, "docs", "shared", "workmap.json")
OUT = os.path.join(ROOT, "docs", "workmap.html")
TPL = os.path.join(ROOT, "scripts", "workmap.template.html")
STATUSES = ["pending", "doing", "pause", "cancel", "done"]
TASK_STATUS = {
    "todo": "pending", "pending": "pending", "open": "pending", "planned": "pending", "backlog": "pending",
    "doing": "doing", "in-progress": "doing", "in_progress": "doing", "inprogress": "doing", "wip": "doing", "active": "doing",
    "blocked": "pause", "paused": "pause", "pause": "pause", "hold": "pause", "on-hold": "pause", "waiting": "pause",
    "done": "done", "closed": "done", "complete": "done", "completed": "done", "finished": "done",
    "cancel": "cancel", "cancelled": "cancel", "canceled": "cancel", "dropped": "cancel",
}
LEVELS = ["root", "epic", "feature", "task", "subtask"]
PREFIX_DEFAULT = {"epic": "", "feature": "P", "task": "T", "subtask": "B"}
MARK = {" ": None, ">": "doing", "=": "pause", "-": "cancel", "x": "done", "X": "done"}
MARK_OUT = {"doing": "[>]", "pause": "[=]", "cancel": "[-]", "done": "[x]", "pending": "[ ]"}
TITLE_MAX = 64
NAME_RANGE = (12, 26)  # style rule: node names of similar length (2-4 words) keep the chips aligned
ICON = {"pending": "○", "doing": "▶", "pause": "‖", "cancel": "✕", "done": "✓"}
LABEL = {
    "en": {"pending": "pending", "doing": "in progress", "pause": "paused", "cancel": "cancelled", "done": "done"},
    "vi": {"pending": "chưa làm", "doing": "đang làm", "pause": "tạm dừng", "cancel": "huỷ", "done": "xong"},
}


def lang_of(data):
    lang = str(data.get("lang", "en")).lower()
    return lang if lang in LABEL else "en"


def prefixes(data):
    p = dict(PREFIX_DEFAULT)
    if isinstance(data.get("prefix"), dict):
        p.update({k: str(v) for k, v in data["prefix"].items() if k in p})
    return p


def level_of(node, depth):
    if node.get("level") in LEVELS:
        return node["level"]
    return "task" if "task" in node else LEVELS[min(depth, 4)]


# ---------------------------------------------------------------- markdown source
def parse_item(text):
    """One list item (after "- ") → node dict."""
    node = {}
    m = re.match(r"^\[(.)\]\s*(.*)$", text)
    if m and m.group(1) in MARK:
        if MARK[m.group(1)]:
            node["status"] = MARK[m.group(1)]
        text = m.group(2)
    m = re.match(r"^`([^`]+)`\s*(.*)$", text)
    if m:
        node["id"] = m.group(1).strip()
        text = m.group(2)
    for sep in (" — ", " -- ", " – "):
        if sep in text:
            text, note = text.split(sep, 1)
            node["note"] = note.strip()
            break
    words = []
    for t in text.split():
        if t.startswith("@") and len(t) > 1:
            node["owner"] = t[1:]
        elif re.fullmatch(r"\(\d{4}-\d{2}-\d{2}\)", t):
            node["at"] = t[1:-1]
        elif t.startswith("task:") and len(t) > 5:
            node["task"] = t[5:]
        elif t.startswith("level:") and t[6:] in LEVELS:
            node["level"] = t[6:]
        else:
            words.append(t)
    if words:
        node["name"] = " ".join(words)
    return node


def parse_md(text):
    lines = text.replace("\r", "").split("\n")
    fm, i = {}, 0
    if lines and lines[0].strip() == "---":
        j = 1
        while j < len(lines) and lines[j].strip() != "---":
            m = re.match(r"^([\w-]+)\s*:\s*(.*)$", lines[j])
            if m:
                fm[m.group(1).lower()] = m.group(2).strip()
            j += 1
        i = j + 1
    data = {"title": fm.get("title", "Project"), "lang": fm.get("lang", "en"), "note": "", "children": []}
    if fm.get("prefix"):
        pre = {}
        for pair in fm["prefix"].split():
            k, _, v = pair.partition("=")
            if k in PREFIX_DEFAULT:
                pre[k] = v
        data["prefix"] = pre
    stack, notes, in_list = [(-1, data)], [], False
    for raw in lines[i:]:
        line = raw.rstrip()
        m = re.match(r"^([ \t]*)[-*]\s+(.*)$", line)
        if m:
            in_list = True
            width = len(m.group(1).replace("\t", "    "))
            node = parse_item(m.group(2))
            while stack[-1][0] >= width:
                stack.pop()
            stack[-1][1].setdefault("children", []).append(node)
            stack.append((width, node))
            continue
        if in_list or not line.strip() or line.lstrip().startswith("<!--"):
            continue
        h = re.match(r"^#\s+(.*)$", line)
        if h:
            data["title"] = h.group(1).strip()
        else:
            notes.append(line.strip())
    data["note"] = " ".join(notes)
    return data


def item_line(node, depth):
    parts = []
    st = node.get("status")
    if st in MARK_OUT and st != "pending":
        parts.append(MARK_OUT[st])
    elif not node.get("children") and "task" not in node:
        parts.append("[ ]")
    if node.get("id"):
        parts.append(f"`{node['id']}`")
    if node.get("name"):
        parts.append(node["name"])
    if node.get("task"):
        parts.append(f"task:{node['task']}")
    if node.get("level") and node["level"] != ("task" if "task" in node else LEVELS[min(depth, 4)]):
        parts.append(f"level:{node['level']}")
    if node.get("owner"):
        parts.append("@" + re.sub(r"\s+", "-", str(node["owner"]).strip()))
    if node.get("at"):
        parts.append(f"({node['at']})")
    line = "  " * (depth - 1) + "- " + " ".join(parts)
    if node.get("note"):
        line += " — " + re.sub(r"\s+", " ", str(node["note"])).strip()
    return line


def to_md(data):
    out = ["---", f"lang: {lang_of(data)}"]
    if data.get("prefix"):
        out.append("prefix: " + " ".join(f"{k}={v}" for k, v in prefixes(data).items()))
    out += ["---", f"# {data.get('title', 'Project')}", ""]
    if data.get("note"):
        out += [data["note"], ""]

    def walk(node, depth):
        for k in node.get("children", []):
            out.append(item_line(k, depth))
            walk(k, depth + 1)
    walk(data, 1)
    return "\n".join(out) + "\n"


def load():
    if os.path.exists(SRC):
        return parse_md(pathlib.Path(SRC).read_text(encoding="utf-8"))
    if os.path.exists(LEGACY):
        try:
            data = json.loads(pathlib.Path(LEGACY).read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            sys.exit(f"{os.path.relpath(LEGACY, ROOT)} is not valid JSON: {e}")
        if not isinstance(data, dict):
            sys.exit(f"{os.path.relpath(LEGACY, ROOT)} must be a JSON object")
        ensure_ids(data)
        save(data)
        print(f"  converted {os.path.relpath(LEGACY, ROOT)} → {os.path.relpath(SRC, ROOT)} (the JSON file is no longer read; delete it when you like)")
        return parse_md(pathlib.Path(SRC).read_text(encoding="utf-8"))
    sys.exit(f"missing {os.path.relpath(SRC, ROOT)} - run the workmap installer, or create it with a '# Title' line "
             "and a markdown list (see the docstring)")


def save(data):
    os.makedirs(os.path.dirname(SRC), exist_ok=True)
    pathlib.Path(SRC).write_text(to_md(data), encoding="utf-8")


# ---------------------------------------------------------------- ids, tasks, tree
def ensure_ids(data):
    """Give every node without an id a new unique one (<prefix><n>, n above every number already used). Returns the count."""
    pre = prefixes(data)
    used, missing = set(), []

    def walk(node, depth):
        for k in node.get("children", []):
            cid = str(k.get("id", "")).strip()
            if cid:
                used.add(cid.lower())
            else:
                missing.append((k, level_of(k, depth + 1)))
            walk(k, depth + 1)
    walk(data, 0)
    counter = {}
    for node, lvl in missing:
        p = pre.get(lvl, "")
        if lvl not in counter:
            nums = [int(i[len(p):]) for i in used if i.startswith(p.lower()) and i[len(p):].isdigit()]
            counter[lvl] = max(nums) if nums else 0
        while True:
            counter[lvl] += 1
            cand = f"{p}{counter[lvl]}"
            if cand.lower() not in used:
                break
        used.add(cand.lower())
        node["id"] = cand
    return len(missing)


def load_tasks():
    """Task files: first heading "# T-012 Title"; "Status:" and "Owner:" lines (or frontmatter keys)."""
    out = {}
    for f in sorted(glob.glob(os.path.join(ROOT, "docs", "tasks", "T-*.md"))):
        txt = pathlib.Path(f).read_text(encoding="utf-8", errors="replace")
        m = re.search(r"^#\s*(T-\d+)\s*[:\-–—]?\s*(.*)$", txt, re.M)
        if not m:
            continue
        st = re.search(r"^(?:status|trạng thái)\s*:\s*([\w-]+)", txt, re.M | re.I)
        key = st.group(1).lower() if st else "todo"
        ow = re.search(r"^(?:owner|assignee|người làm)\s*:\s*(.+?)\s*$", txt, re.M | re.I)
        out[m.group(1)] = {"title": m.group(2).strip(), "status": TASK_STATUS.get(key, "pending"),
                           "owner": ow.group(1).strip() if ow else ""}
    return out


def aggregate(sts):
    live = [s for s in sts if s != "cancel"]
    if not live:
        return "cancel"
    if "doing" in live:
        return "doing"
    if all(s == "done" for s in live):
        return "done"
    if "pause" in live:
        return "pause"
    return "doing" if "done" in live else "pending"


def resolve(node, tasks, depth):
    """Source node → display node: fill task name/status/owner, compute a parent's status from its children."""
    n = {"level": level_of(node, depth), "name": node.get("name", ""), "code": str(node.get("id", ""))}
    for k in ("note", "at", "owner"):
        if node.get(k):
            n[k] = node[k]
    if "task" in node:
        t = tasks.get(node["task"], {"title": node.get("name") or "(task file not found)", "status": "pending", "owner": ""})
        title = t["title"] if len(t["title"]) <= TITLE_MAX else t["title"][: TITLE_MAX - 1] + "…"
        n.update(name=f'{node["task"]} · {title}', status=t["status"], ref=node["task"])
        if "owner" not in n and t.get("owner"):
            n["owner"] = t["owner"]
    kids = [resolve(c, tasks, depth + 1) for c in node.get("children", [])]
    if kids:
        n["children"] = kids
    if "status" in node:
        n["status"] = node["status"]
    elif "status" not in n:
        n["status"] = aggregate([k["status"] for k in kids]) if kids else "pending"
    return n


def tree(data):
    return resolve({"level": "root", "name": data.get("title", "Project"), "children": data.get("children", [])}, load_tasks(), 0)


def docs_nav(title, lang):
    """Navigation bar for the map page. It reuses the links of docs/index.html (any <nav> there, for example the one
    the free workdocs skill writes), so the menu is the same on every page; the Work map entry is added when the
    docs do not list it. Without docs/index.html the page stands alone and gets no bar."""
    import html as H
    idx = os.path.join(os.path.dirname(OUT), "index.html")
    if not os.path.exists(idx):
        return ""
    try:
        page = pathlib.Path(idx).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    lb = {"vi": ("Tổng quan", "Bản đồ công việc")}.get(lang, ("Overview", "Work map"))
    items = []
    m = re.search(r"<nav\b[^>]*>(.*?)</nav>", page, re.S | re.I)
    for attrs, text in (re.findall(r"<a\b([^>]*)>(.*?)</a>", m.group(1), re.S | re.I) if m else []):
        h = re.search(r'href\s*=\s*"([^"]+)"', attrs, re.I)
        t = H.unescape(re.sub(r"<[^>]+>", "", text)).strip()
        if h and t and not re.match(r"(?i)(javascript|data|vbscript):", h.group(1).strip()):
            items.append((h.group(1), t, bool(re.search(r'class="[^"]*\b(wd-name|brand)\b', attrs))))
    brand = (items[0][0], items[0][1]) if items and (items[0][2] or items[0][1].lower().endswith(" docs")) else ("index.html", f"{title} docs")
    links = [(h, t) for h, t, _ in (items[1:] if items and brand[0] == items[0][0] and brand[1] == items[0][1] else items)]
    if not links:
        links = [("index.html", lb[0])]
    if not any(h == "workmap.html" for h, _ in links):
        links.append(("workmap.html", lb[1]))
    e = lambda x: H.escape(x, quote=True)
    out = [f'<nav class="topnav" aria-label="Documentation"><div class="in"><a class="brand" href="{e(brand[0])}">{e(brand[1])}</a>']
    out += [f'<a class="p" href="{e(h)}"{" aria-current=\"page\"" if h == "workmap.html" else ""}>{e(t)}</a>' for h, t in links]
    return "".join(out) + "</div></nav>\n"


def render(data):
    if not os.path.exists(TPL):
        sys.exit(f"missing {os.path.relpath(TPL, ROOT)} - copy assets/workmap.template.html from the workmap skill")
    t = tree(data)
    t["lang"] = lang_of(data)
    t["note"] = data.get("note", "")
    tpl = pathlib.Path(TPL).read_text(encoding="utf-8")
    payload = json.dumps(t, ensure_ascii=False).replace("</", "<\\/")
    title = str(data.get("title", "Project")).replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    nav = docs_nav(str(data.get("title", "Project")), t["lang"])   # same menu as the documentation pages, if any
    html = (tpl.replace("/*__WORKMAP_DATA__*/null", payload)
               .replace("__WORKMAP_TITLE__", title)
               .replace("__WORKMAP_LANG__", t["lang"])
               .replace("__WORKMAP_NAV__", nav))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    pathlib.Path(OUT).write_text(html, encoding="utf-8")
    print(f"wrote {os.path.relpath(OUT, ROOT)}")


# ---------------------------------------------------------------- lookup
def label(node, tasks):
    if "task" in node:
        t = tasks.get(node["task"])
        return f'{node["task"]} · {t["title"]}' if t else node["task"]
    return node.get("name", "")


def split_path(path):
    """Split "A/B\\/C/D" → ["A", "B/C", "D"]: "\\/" is a "/" inside a name."""
    return [p.strip().replace("\\/", "/") for p in re.split(r"(?<!\\)/", path) if p.strip()]


def join_path(parts):
    return "/".join(p.replace("/", "\\/") for p in parts)


def by_id(data, text):
    """Node whose id equals text (case-insensitive), anywhere in the tree → (node, depth) or None."""
    q = text.strip().lower()
    if not q:
        return None

    def walk(node, depth):
        for k in node.get("children", []):
            if str(k.get("id", "")).lower() == q:
                return k, depth + 1
            hit = walk(k, depth + 1)
            if hit:
                return hit
    return walk(data, 0)


def match(kids, part, tasks):
    """Children matching one path segment: exact id, name or task first, then substring."""
    q = part.lower()
    exact = [k for k in kids if str(k.get("id", "")).lower() == q or label(k, tasks).lower() == q
             or k.get("name", "").lower() == q or k.get("task", "").lower() == q]
    return exact or [k for k in kids if q in label(k, tasks).lower()]


def find(data, path, create=False):
    """Walk a path "A/B/C" (or a single id such as T12) → (source node, depth). create=True adds missing segments."""
    parts = split_path(path)
    if len(parts) == 1:
        hit = by_id(data, parts[0])
        if hit:
            return hit
    tasks = load_tasks()
    node, depth = data, 0
    for part in parts:
        kids = node.setdefault("children", []) if create else node.get("children", [])
        hits = match(kids, part, tasks)
        if len(hits) > 1:
            sys.exit(f'"{part}" matches several nodes: ' + ", ".join(f'{k.get("id", "?")} {label(k, tasks)}' for k in hits) + " - use the id or the full name")
        if hits:
            node = hits[0]
        elif create:
            node = {"name": part}
            kids.append(node)
            print(f"  created: {part}")
        else:
            sys.exit(f'"{part}" not found in "{path}" - try: python3 scripts/workmap.py find "{part}"')
        depth += 1
    return node, depth


def path_of(data, target):
    """Names from the root down to target (by identity)."""
    tasks = load_tasks()

    def walk(node, path):
        for k in node.get("children", []):
            p = path + [label(k, tasks)]
            if k is target:
                return p
            hit = walk(k, p)
            if hit:
                return hit
    return walk(data, []) or []


# ---------------------------------------------------------------- commands
def counts(t):
    """Count leaf nodes per status (leaves are the real work; parents only aggregate)."""
    c = {s: 0 for s in STATUSES}

    def walk(n):
        kids = n.get("children", [])
        if not kids:
            c[n["status"]] = c.get(n["status"], 0) + 1
        for k in kids:
            walk(k)
    walk(t)
    return c


def summary_line(t, lang):
    c = counts(t)
    live = sum(c.values()) - c["cancel"]  # % done over non-cancelled work, same as the page
    pct = f" · {round(100 * c['done'] / live)}% {LABEL[lang]['done']} ({c['done']}/{live})" if live else ""
    return " · ".join(f"{ICON[s]} {c[s]} {LABEL[lang][s]}" for s in ("done", "doing", "pending", "pause", "cancel")) + pct


def cmd_show(data, path, max_depth, status):
    if path:
        node, depth = find(data, path)
        t = resolve(node, load_tasks(), depth)
    else:
        t = tree(data)

    def keep(n):
        return not status or n["status"] == status or any(keep(k) for k in n.get("children", []))

    def walk(n, d):
        if d > max_depth or not keep(n):
            return
        tag = "" if n["level"] in ("root", "task", "subtask") else f' [{n["level"]}]'
        code = f'{n["code"]} ' if n.get("code") else ""
        owner = f' @{n["owner"]}' if n.get("owner") else ""
        print("  " * d + f'{ICON[n["status"]]} {code}{n["name"]}{tag}{owner}' + (f'  — {n["note"]}' if n.get("note") else ""))
        for k in n.get("children", []):
            walk(k, d + 1)
    walk(t, 0)
    if not path:
        print(summary_line(t, lang_of(data)))


def cmd_find(data, text):
    tasks = load_tasks()
    q = text.lower()
    hits = []

    def walk(node, path, depth):
        for k in node.get("children", []):
            lab = label(k, tasks)
            p = path + [lab]
            if (q in lab.lower() or q in str(k.get("note", "")).lower() or q == k.get("task", "").lower()
                    or q == str(k.get("id", "")).lower() or q == str(k.get("owner", "")).lower()):
                hits.append((k.get("id", ""), p, resolve(k, tasks, depth + 1)["status"]))
            walk(k, p, depth + 1)
    walk(data, [], 0)
    for cid, p, st in hits:
        print(f"{ICON[st]} {cid}  {join_path(p)}")
    if not hits:
        sys.exit(f'no node contains "{text}" - see: python3 scripts/workmap.py show -d 2')


def clean_owner(s):
    return re.sub(r"\s+", "-", s.strip()) if s and s.strip() else ""


def main():
    ap = argparse.ArgumentParser(description="workmap - project work map (see the docstring for examples)")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("show", help="print the outline with ids, owners and statuses")
    s.add_argument("path", nargs="?", default="", help="path or id to start from")
    s.add_argument("-d", "--depth", type=int, default=9)
    s.add_argument("-s", "--status", choices=STATUSES, help="keep only branches containing this status")
    f = sub.add_parser("find", help="search nodes by name, note, id, owner or task")
    f.add_argument("text")
    a = sub.add_parser("add", help="add a node under a parent path or id")
    a.add_argument("parent")
    a.add_argument("name")
    a.add_argument("-s", "--status", choices=STATUSES)
    a.add_argument("-o", "--owner", help="who does the work: an agent name or a person")
    a.add_argument("-t", "--task", help="task id, e.g. T-012 (name, status and owner from docs/tasks)")
    a.add_argument("-n", "--note")
    e = sub.add_parser("set", help="change a node's status (by path or id)")
    e.add_argument("path")
    e.add_argument("status", choices=STATUSES + ["auto"])
    e.add_argument("-o", "--owner", help='who does the work (-o "" clears it)')
    e.add_argument("-n", "--note")
    args = ap.parse_args()
    data = load()
    assigned = ensure_ids(data)
    if assigned:
        save(data)
        print(f"  assigned ids to {assigned} node(s) without one")
    today = datetime.date.today().isoformat()
    if args.cmd == "show":
        return cmd_show(data, args.path, args.depth, args.status)
    if args.cmd == "find":
        return cmd_find(data, args.text)
    if args.cmd == "add":
        if not args.task and not args.name:
            sys.exit("give a <Name> or -t T-xxx")
        parent, depth = find(data, args.parent, create=True)
        kids = parent.setdefault("children", [])
        tasks = load_tasks()
        dup = [k for k in kids if (args.task and k.get("task", "").lower() == args.task.lower())
               or (args.name and k.get("name", "").lower() == args.name.lower())]
        if dup:
            sys.exit(f'"{label(dup[0], tasks)}" already exists under "{args.parent}" as {dup[0].get("id", "?")} - use: '
                     f'set {dup[0].get("id", "<id>")} <status>')
        if args.name and not NAME_RANGE[0] <= len(args.name) <= NAME_RANGE[1]:
            print(f'  note: "{args.name}" is {len(args.name)} characters; node names should be {NAME_RANGE[0]}-{NAME_RANGE[1]} '
                  "characters (2-4 words) so the chips line up - put details in -n")
        node = {"task": args.task} if args.task else {"name": args.name}
        if args.task and args.name:
            node["name"] = args.name
        if args.status:
            node["status"] = args.status
        if clean_owner(args.owner or ""):
            node["owner"] = clean_owner(args.owner)
        if args.note:
            node["note"] = args.note
        node["at"] = today
        kids.append(node)
        ensure_ids(data)
        print(f'  added: {node["id"]} · {args.task or args.name}' + (f" ({LABEL[lang_of(data)][args.status]})" if args.status else "")
              + (f' @{node["owner"]}' if node.get("owner") else "")
              + f' under {join_path(path_of(data, parent)) or data.get("title", "root")}')
    elif args.cmd == "set":
        node, _ = find(data, args.path)
        if args.status == "auto":
            node.pop("status", None)
        else:
            node["status"] = args.status
        if args.owner is not None:
            if clean_owner(args.owner):
                node["owner"] = clean_owner(args.owner)
            else:
                node.pop("owner", None)
        if args.note:
            node["note"] = args.note
        node["at"] = today
        print(f'  {node.get("id", "")} {label(node, load_tasks())} → {args.status}' + (f' @{node["owner"]}' if node.get("owner") else ""))
    if args.cmd in ("add", "set"):
        save(data)
    render(data)


if __name__ == "__main__":
    main()
