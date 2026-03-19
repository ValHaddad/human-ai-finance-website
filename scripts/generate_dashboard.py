#!/usr/bin/env python3
"""
Pull survey response data from OSF and generate dashboard summary JSON.

Usage:
    python scripts/generate_dashboard.py              # Generate dashboard_data.json (uses cache)
    python scripts/generate_dashboard.py --no-cache   # Force re-download all files
    python scripts/generate_dashboard.py --inspect     # Print raw data for inspection
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import time

import requests

OSF_NODE_ID = "gqjvc"
OSF_API_BASE = "https://api.osf.io/v2"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / "scripts" / ".cache"

# Map for friendly task labels
TASK_LABELS = {
    "main_idea": "Main Idea",
    "lit_review": "Literature Review",
    "data_collection": "Data Collection",
    "data_analysis": "Data Analysis",
    "theorem_proofs": "Theorem/Proofs",
    "numerical_sim": "Numerical Simulation",
    "writing_editing": "Writing & Editing",
}

ROLE_LABELS = {
    "not_relevant": "Not Relevant",
    "tool": "Tool",
    "assistant": "Assistant",
    "thought_partner": "Thought Partner",
    "primary": "Primary Contributor",
    "editor": "Editor",
}


def load_api_key():
    """Load OSF_API_KEY from .env file or environment."""
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("OSF_API_KEY=") and not line.startswith("#"):
                return line.split("=", 1)[1].strip()
    key = os.environ.get("OSF_API_KEY")
    if not key:
        print("Error: OSF_API_KEY not found in .env or environment.", file=sys.stderr)
        sys.exit(1)
    return key


def list_osf_files(api_key):
    """List all files in the OSF node's osfstorage, handling pagination."""
    url = f"{OSF_API_BASE}/nodes/{OSF_NODE_ID}/files/osfstorage/"
    headers = {"Authorization": f"Bearer {api_key}"}
    params = {"page[size]": 100}

    all_files = []
    while url:
        for attempt in range(3):
            resp = requests.get(url, headers=headers, params=params)
            if resp.status_code in (502, 503, 504) and attempt < 2:
                wait = 2 ** attempt  # 1s, 2s
                print(f"  OSF returned {resp.status_code}, retrying in {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            break
        data = resp.json()

        for item in data.get("data", []):
            attrs = item.get("attributes", {})
            if attrs.get("kind") == "file":
                # Use the Waterbutler move/upload URL for downloads (works with Bearer auth)
                waterbutler_url = item.get("links", {}).get("move", "")
                all_files.append({
                    "name": attrs.get("name", ""),
                    "size": attrs.get("size", 0),
                    "date_created": attrs.get("date_created", ""),
                    "waterbutler_url": waterbutler_url,
                })

        url = data.get("links", {}).get("next")
        params = {}

    return all_files


def download_json(url, api_key):
    """Download a JSON file from OSF via Waterbutler and return parsed data."""
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        resp = requests.get(url, headers=headers, params={"action": "download"})
        resp.raise_for_status()
        return json.loads(resp.text)
    except requests.exceptions.SSLError:
        # OSF certificate mismatch: files.osf.io cert shows files.us.osf.io
        alt_url = url.replace("files.osf.io", "files.us.osf.io")
        if alt_url != url:
            resp = requests.get(alt_url, headers=headers, params={"action": "download"})
            resp.raise_for_status()
            return json.loads(resp.text)
        raise


def load_cache_manifest():
    """Load the cache manifest mapping filenames to {date_created, size}."""
    manifest_path = CACHE_DIR / "manifest.json"
    if manifest_path.exists():
        return json.loads(manifest_path.read_text())
    return {}


def save_cache_manifest(manifest):
    """Persist the cache manifest to disk."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))


def get_or_download_json(file_info, api_key, manifest):
    """Return parsed JSON for an OSF file, using cache when possible.

    Returns (data, was_cached) tuple.
    """
    name = file_info["name"]
    cached_entry = manifest.get(name)
    cached_path = CACHE_DIR / name

    if (cached_entry
            and cached_entry.get("date_created") == file_info["date_created"]
            and cached_entry.get("size") == file_info["size"]
            and cached_path.exists()):
        return json.loads(cached_path.read_text()), True

    # Cache miss — download and store
    data = download_json(file_info["waterbutler_url"], api_key)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached_path.write_text(json.dumps(data))
    manifest[name] = {
        "date_created": file_info["date_created"],
        "size": file_info["size"],
    }
    return data, False


def parse_session_id(filename):
    """Extract session ID from filename like '2026-03-04T18-44-39-156Z_mmcdv29dk1tm8p.json'."""
    # Strip colab_ prefix if present
    name = filename
    if name.startswith("colab_"):
        name = name[6:]
    # Pattern: {timestamp}_{session_id}[_suffix].ext
    match = re.match(r"[\dT\-Z]+_([a-z0-9]+)", name)
    return match.group(1) if match else None


def parse_submission_date(filename):
    """Extract date from filename timestamp like '2026-03-04T18-44-39-156Z_...'."""
    name = filename
    if name.startswith("colab_"):
        name = name[6:]
    match = re.match(r"(\d{4}-\d{2}-\d{2})", name)
    return match.group(1) if match else None


def extract_survey_responses(trials):
    """Merge all survey trial responses into a single dict."""
    merged = {}
    for trial in trials:
        if trial.get("trial_type") == "survey":
            resp = trial.get("response", {})
            # Skip null/disclaimer fields
            for k, v in resp.items():
                if v is not None and not k.endswith("_disclaimer") and not k.endswith("_instructions"):
                    merged[k] = v
    return merged


def compute_aggregates(submissions, coauthor_submissions):
    """Compute aggregate statistics from parsed submissions."""
    now = datetime.now(tz=__import__('datetime').timezone.utc).isoformat(timespec="seconds")

    # Submissions by date
    date_counts = Counter()
    for s in submissions:
        if s.get("_date"):
            date_counts[s["_date"]] += 1
    submissions_by_date = [{"date": d, "count": c} for d, c in sorted(date_counts.items())]

    # Field distribution
    field_dist = Counter(s.get("primary_field", "Unknown") for s in submissions)

    # Programming proficiency
    prog_dist = Counter()
    for s in submissions:
        val = s.get("programming_proficiency")
        if val is not None:
            prog_dist[str(val)] += 1

    # Paper writing experience
    exp_dist = Counter()
    for s in submissions:
        val = s.get("paper_writing_experience")
        if val is not None:
            exp_dist[str(val)] += 1

    # AI tools usage
    tool_counts = Counter()
    for s in submissions:
        tools = s.get("ai_tools_used", [])
        if isinstance(tools, list):
            for t in tools:
                if isinstance(t, dict) and t.get("tool_name"):
                    tool_counts[t["tool_name"].strip().title()] += 1

    # AI role by task
    role_by_task = defaultdict(lambda: Counter())
    for s in submissions:
        roles = s.get("ai_role_by_task", {})
        if isinstance(roles, dict):
            for task, role in roles.items():
                if role:
                    role_by_task[task][role] += 1
    # Convert to serializable dict
    role_by_task_out = {}
    for task in TASK_LABELS:
        if task in role_by_task:
            role_by_task_out[task] = dict(role_by_task[task])
        else:
            role_by_task_out[task] = {}

    # Hours distribution
    hours_personal = Counter(s.get("personal_hours", "Unknown") for s in submissions if s.get("personal_hours"))
    hours_team = Counter(s.get("team_hours", "Unknown") for s in submissions if s.get("team_hours"))
    hours_counterfactual = Counter(s.get("counterfactual_hours", "Unknown") for s in submissions if s.get("counterfactual_hours"))

    # Self-evaluation means
    eval_sums = defaultdict(list)
    for s in submissions:
        se = s.get("self_evaluation", {})
        if isinstance(se, dict):
            for dim, val in se.items():
                if isinstance(val, (int, float)):
                    eval_sums[dim].append(val)
    eval_means = {dim: round(sum(vals) / len(vals), 2) for dim, vals in eval_sums.items() if vals}

    # Scalar means
    def mean_of(field):
        vals = [s[field] for s in submissions if isinstance(s.get(field), (int, float))]
        return round(sum(vals) / len(vals), 2) if vals else None

    # AI experience duration
    ai_exp_dist = Counter(s.get("ai_experience_duration", "Unknown") for s in submissions if s.get("ai_experience_duration"))

    # Number of co-authors per paper
    coauthor_counts = Counter()
    for s in submissions:
        authors = s.get("authors", [])
        if isinstance(authors, list):
            coauthor_counts[str(len(authors))] += 1

    # Tool reliance levels (aggregate usage_level across all tool entries)
    reliance_dist = Counter()
    for s in submissions:
        tools = s.get("ai_tools_used", [])
        if isinstance(tools, list):
            for t in tools:
                if isinstance(t, dict) and t.get("usage_level") is not None:
                    reliance_dist[str(t["usage_level"])] += 1

    # Likert distributions (1-7)
    def likert_dist(field):
        dist = Counter()
        for s in submissions:
            val = s.get(field)
            if isinstance(val, (int, float)):
                dist[str(int(val))] += 1
        return dict(dist)

    # AI coordination strategy (multi-author papers only)
    coord_dist = Counter(s.get("ai_coordination") for s in submissions if s.get("ai_coordination"))

    # Submitter's AI role (multi-author papers only)
    ai_role_dist = Counter(s.get("your_ai_role") for s in submissions if s.get("your_ai_role"))

    # Papers with authors and affiliations
    papers = []
    for s in submissions:
        title = s.get("paper_title")
        if not title:
            continue
        authors = s.get("authors", [])
        author_list = []
        if isinstance(authors, list):
            for a in authors:
                if isinstance(a, dict) and a.get("author_name"):
                    author_list.append({
                        "name": a["author_name"],
                        "affiliation": a.get("author_affiliation", "")
                    })
        papers.append({"title": title, "authors": author_list})

    # --- Cross-tabulations ---

    # Tool usage intensity: average usage_level per tool
    tool_usage_levels = defaultdict(list)
    for s in submissions:
        tools = s.get("ai_tools_used", [])
        if isinstance(tools, list):
            for t in tools:
                if isinstance(t, dict) and t.get("tool_name") and t.get("usage_level") is not None:
                    tool_usage_levels[t["tool_name"].strip().title()].append(int(t["usage_level"]))
    ai_tools_avg_usage = {
        tool: round(sum(vals) / len(vals), 2)
        for tool, vals in tool_usage_levels.items() if vals
    }

    # Self-evaluation by field
    eval_by_field = defaultdict(lambda: defaultdict(list))
    for s in submissions:
        field = s.get("primary_field", "Unknown")
        se = s.get("self_evaluation", {})
        if isinstance(se, dict):
            for dim, val in se.items():
                if isinstance(val, (int, float)):
                    eval_by_field[field][dim].append(val)
    self_eval_by_field = {
        field: {dim: round(sum(vals) / len(vals), 2) for dim, vals in dims.items() if vals}
        for field, dims in eval_by_field.items()
    }

    # Self-evaluation by AI role
    eval_by_role = defaultdict(lambda: defaultdict(list))
    for s in submissions:
        role = s.get("your_ai_role")
        if not role:
            continue
        se = s.get("self_evaluation", {})
        if isinstance(se, dict):
            for dim, val in se.items():
                if isinstance(val, (int, float)):
                    eval_by_role[role][dim].append(val)
    self_eval_by_role = {
        role: {dim: round(sum(vals) / len(vals), 2) for dim, vals in dims.items() if vals}
        for role, dims in eval_by_role.items()
    }

    # Satisfaction / future_ai / review_influence by field
    def likert_by_field(field_name):
        result = defaultdict(list)
        for s in submissions:
            val = s.get(field_name)
            f = s.get("primary_field", "Unknown")
            if isinstance(val, (int, float)):
                result[f].append(val)
        return {
            f: round(sum(vals) / len(vals), 2)
            for f, vals in result.items() if vals
        }

    # Reliance by programming proficiency
    reliance_by_prof = defaultdict(list)
    for s in submissions:
        prof = s.get("programming_proficiency")
        tools = s.get("ai_tools_used", [])
        if prof is not None and isinstance(tools, list):
            for t in tools:
                if isinstance(t, dict) and t.get("usage_level") is not None:
                    reliance_by_prof[str(prof)].append(int(t["usage_level"]))
    reliance_by_proficiency = {
        k: round(sum(v) / len(v), 2) for k, v in reliance_by_prof.items() if v
    }

    # --- Binning helpers ---
    def bin_writing_exp(val):
        """Bin paper_writing_experience 1-5 into Junior/Mid-Career/Senior."""
        if val in (1, 2):
            return "Junior (1–2)"
        elif val == 3:
            return "Mid-Career (3)"
        elif val in (4, 5):
            return "Senior (4–5)"
        return None

    def bin_ai_exp(val):
        """Bin ai_experience_duration into New/Moderate/Veteran."""
        if val in ("none", "<3mo", "3-6mo"):
            return "New (<6 mo)"
        elif val in ("6-12mo", "1-2yr"):
            return "Moderate (6 mo–2 yr)"
        elif val == "2yr+":
            return "Veteran (2+ yr)"
        return None

    # Self-evaluation by writing experience
    eval_by_wexp = defaultdict(lambda: defaultdict(list))
    for s in submissions:
        wbin = bin_writing_exp(s.get("paper_writing_experience"))
        if not wbin:
            continue
        se = s.get("self_evaluation", {})
        if isinstance(se, dict):
            for dim, val in se.items():
                if isinstance(val, (int, float)):
                    eval_by_wexp[wbin][dim].append(val)
    self_eval_by_writing_exp = {
        b: {dim: round(sum(vals) / len(vals), 2) for dim, vals in dims.items() if vals}
        for b, dims in eval_by_wexp.items()
    }

    # Self-evaluation by AI experience (binned)
    eval_by_aiexp = defaultdict(lambda: defaultdict(list))
    for s in submissions:
        abin = bin_ai_exp(s.get("ai_experience_duration"))
        if not abin:
            continue
        se = s.get("self_evaluation", {})
        if isinstance(se, dict):
            for dim, val in se.items():
                if isinstance(val, (int, float)):
                    eval_by_aiexp[abin][dim].append(val)
    self_eval_by_ai_exp = {
        b: {dim: round(sum(vals) / len(vals), 2) for dim, vals in dims.items() if vals}
        for b, dims in eval_by_aiexp.items()
    }

    # Likert means by writing experience
    def likert_by_writing_exp(field_name):
        result = defaultdict(list)
        for s in submissions:
            val = s.get(field_name)
            wbin = bin_writing_exp(s.get("paper_writing_experience"))
            if isinstance(val, (int, float)) and wbin:
                result[wbin].append(val)
        return {b: round(sum(v) / len(v), 2) for b, v in result.items() if v}

    # Likert means by AI experience (binned)
    def likert_by_ai_exp(field_name):
        result = defaultdict(list)
        for s in submissions:
            val = s.get(field_name)
            abin = bin_ai_exp(s.get("ai_experience_duration"))
            if isinstance(val, (int, float)) and abin:
                result[abin].append(val)
        return {b: round(sum(v) / len(v), 2) for b, v in result.items() if v}

    # Counterfactual by AI experience
    cf_by_exp = defaultdict(lambda: Counter())
    for s in submissions:
        exp = s.get("ai_experience_duration")
        cf = s.get("counterfactual_hours")
        if exp and cf:
            cf_by_exp[exp][cf] += 1
    counterfactual_by_experience = {
        exp: dict(counts) for exp, counts in cf_by_exp.items()
    }

    return {
        "generated_at": now,
        "submission_deadline": "2026-03-18",
        "total_submissions": len(submissions),
        "total_coauthor_responses": len(coauthor_submissions),
        "submissions_by_date": submissions_by_date,
        "field_distribution": dict(field_dist),
        "programming_proficiency": dict(prog_dist),
        "paper_writing_experience": dict(exp_dist),
        "ai_experience_duration": dict(ai_exp_dist),
        "num_coauthors_distribution": dict(coauthor_counts),
        "ai_tools": dict(tool_counts.most_common()),
        "tool_reliance_distribution": dict(reliance_dist),
        "ai_role_by_task": role_by_task_out,
        "hours": {
            "personal": dict(hours_personal),
            "team": dict(hours_team),
            "counterfactual": dict(hours_counterfactual),
        },
        "ai_coordination_distribution": dict(coord_dist),
        "ai_role_distribution": dict(ai_role_dist),
        "self_evaluation_means": eval_means,
        "satisfaction_mean": mean_of("satisfaction"),
        "future_ai_likelihood_mean": mean_of("future_ai_likelihood"),
        "ai_review_influence_mean": mean_of("ai_review_influence"),
        "satisfaction_distribution": likert_dist("satisfaction"),
        "future_ai_likelihood_distribution": likert_dist("future_ai_likelihood"),
        "ai_review_influence_distribution": likert_dist("ai_review_influence"),
        "papers": papers,
        "task_labels": TASK_LABELS,
        "role_labels": ROLE_LABELS,
        # Cross-tabulations
        "ai_tools_avg_usage": ai_tools_avg_usage,
        "self_evaluation_by_field": self_eval_by_field,
        "self_evaluation_by_ai_role": self_eval_by_role,
        "satisfaction_by_field": likert_by_field("satisfaction"),
        "future_ai_likelihood_by_field": likert_by_field("future_ai_likelihood"),
        "ai_review_influence_by_field": likert_by_field("ai_review_influence"),
        "reliance_by_proficiency": reliance_by_proficiency,
        "counterfactual_by_experience": counterfactual_by_experience,
        # Binned cross-tabs: writing experience
        "self_evaluation_by_writing_exp": self_eval_by_writing_exp,
        "satisfaction_by_writing_exp": likert_by_writing_exp("satisfaction"),
        "future_ai_likelihood_by_writing_exp": likert_by_writing_exp("future_ai_likelihood"),
        "ai_review_influence_by_writing_exp": likert_by_writing_exp("ai_review_influence"),
        # Binned cross-tabs: AI experience
        "self_evaluation_by_ai_exp": self_eval_by_ai_exp,
        "satisfaction_by_ai_exp": likert_by_ai_exp("satisfaction"),
        "future_ai_likelihood_by_ai_exp": likert_by_ai_exp("future_ai_likelihood"),
        "ai_review_influence_by_ai_exp": likert_by_ai_exp("ai_review_influence"),
    }


def inspect_data(api_key):
    """Download and display raw data files for inspection."""
    print("Listing files in OSF node...\n")
    files = list_osf_files(api_key)

    print(f"Found {len(files)} files:\n")
    for f in files:
        size_kb = f["size"] / 1024 if f["size"] else 0
        print(f"  {f['name']}  ({size_kb:.1f} KB)  [{f['date_created']}]")

    json_files = [f for f in files if f["name"].endswith(".json")]
    csv_files = [f for f in files if f["name"].endswith(".csv")]
    other = [f for f in files if not f["name"].endswith((".json", ".csv"))]
    print(f"\nBreakdown: {len(json_files)} JSON, {len(csv_files)} CSV, {len(other)} other")

    # Download and show first primary survey JSON
    primary_jsons = [f for f in json_files if not f["name"].endswith("_coauthors.json") and not f["name"].startswith("colab_")]
    if primary_jsons:
        sample = primary_jsons[0]
        print(f"\n{'='*60}")
        print(f"Sample primary survey: {sample['name']}")
        print(f"{'='*60}\n")
        trials = download_json(sample["waterbutler_url"], api_key)
        merged = extract_survey_responses(trials)
        for k, v in merged.items():
            val_str = json.dumps(v)
            if len(val_str) > 200:
                val_str = val_str[:200] + "..."
            print(f"  {k}: {val_str}")


def generate(api_key, use_cache=True):
    """Full pipeline: list files, download surveys, aggregate, write JSON."""
    print("Listing files from OSF...")
    files = list_osf_files(api_key)

    # Identify primary survey JSONs and colab survey JSONs
    primary_files = []
    colab_files = []
    for f in files:
        name = f["name"]
        if not name.endswith(".json"):
            continue
        if name.endswith("_coauthors.json"):
            continue
        if name.startswith("colab_"):
            colab_files.append(f)
        else:
            primary_files.append(f)

    print(f"Found {len(primary_files)} primary submissions, {len(colab_files)} co-author responses")

    manifest = load_cache_manifest() if use_cache else {}

    # Download and parse primary submissions
    submissions = []
    cached_count = 0
    for i, f in enumerate(primary_files):
        try:
            trials, was_cached = get_or_download_json(f, api_key, manifest)
            tag = "cached" if was_cached else "new"
            if was_cached:
                cached_count += 1
            print(f"  [{i+1}/{len(primary_files)}] ({tag}) {f['name']}")
            merged = extract_survey_responses(trials)
            merged["_date"] = parse_submission_date(f["name"])
            merged["_session_id"] = parse_session_id(f["name"])
            # Strip base64 file content to save memory
            for key in ("paper_pdf", "paper_source"):
                if key in merged:
                    del merged[key]
            # Filter out test submissions (keep data in OSF, just skip for dashboard)
            title = (merged.get("paper_title") or "").strip().lower()
            if "test" in title:
                print(f"    Skipping test submission: \"{merged.get('paper_title')}\"")
                continue
            submissions.append(merged)
        except Exception as e:
            print(f"    Warning: Failed to parse {f['name']}: {e}")

    # Download and parse co-author submissions
    coauthor_submissions = []
    for i, f in enumerate(colab_files):
        try:
            trials, was_cached = get_or_download_json(f, api_key, manifest)
            tag = "cached" if was_cached else "new"
            if was_cached:
                cached_count += 1
            print(f"  [{i+1}/{len(colab_files)}] ({tag}) coauthor: {f['name']}")
            merged = extract_survey_responses(trials)
            merged["_date"] = parse_submission_date(f["name"])
            coauthor_submissions.append(merged)
        except Exception as e:
            print(f"    Warning: Failed to parse {f['name']}: {e}")

    total_files = len(primary_files) + len(colab_files)
    print(f"\n  {cached_count}/{total_files} from cache, {total_files - cached_count} downloaded")
    save_cache_manifest(manifest)

    # Deduplicate: if the same paper title appears multiple times, keep only the latest
    seen = {}
    for s in submissions:
        title_key = (s.get("paper_title") or "").strip().lower()
        if not title_key:
            # Keep submissions with no title (shouldn't happen, but be safe)
            continue
        if title_key in seen:
            existing = seen[title_key]
            # Keep the one with the later date (files are named with ISO timestamps)
            if (s.get("_date") or "") >= (existing.get("_date") or ""):
                seen[title_key] = s
        else:
            seen[title_key] = s

    # Rebuild submissions list: deduplicated entries + any without titles
    no_title = [s for s in submissions if not (s.get("paper_title") or "").strip()]
    deduped = list(seen.values()) + no_title
    removed = len(submissions) - len(deduped)
    if removed > 0:
        print(f"\n  Deduplicated: removed {removed} duplicate submission(s) (keeping latest per paper title)")
    submissions = deduped

    # Compute aggregates
    print("\nComputing aggregates...")
    aggregates = compute_aggregates(submissions, coauthor_submissions)

    # Write output
    output_path = PROJECT_ROOT / "dashboard" / "dashboard_data.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(aggregates, f, indent=2)

    print(f"\nDashboard data written to: {output_path}")
    print(f"  Total submissions: {aggregates['total_submissions']}")
    print(f"  Total co-author responses: {aggregates['total_coauthor_responses']}")
    print(f"  Fields: {aggregates['field_distribution']}")
    print(f"  AI tools: {aggregates['ai_tools']}")


def main():
    parser = argparse.ArgumentParser(description="Generate dashboard data from OSF survey responses")
    parser.add_argument("--inspect", action="store_true", help="Inspect raw data without generating dashboard")
    parser.add_argument("--no-cache", action="store_true", help="Force re-download all files (ignore cache)")
    args = parser.parse_args()

    api_key = load_api_key()

    if args.inspect:
        inspect_data(api_key)
    else:
        generate(api_key, use_cache=not args.no_cache)


if __name__ == "__main__":
    main()
