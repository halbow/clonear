# Cloinear task runner — manage the file-based kanban board.
# Run `just` with no args to list recipes.

projects_dir := "projects"
port := "8000"

# Show available recipes.
default:
    @just --list

# --- build & serve -------------------------------------------------------- #

# Regenerate manifest.json from the folder tree.
build:
    python3 build.py

# Fail if manifest.json is missing or stale (used by CI).
check:
    python3 build.py --check

# Build the manifest and serve the site at http://localhost:{{port}}
serve: build
    @echo "Serving http://localhost:{{port}}  (Ctrl-C to stop)"
    python3 -m http.server {{port}}

# --- inspect -------------------------------------------------------------- #

# List projects, or the tickets of one project: `just list web-app`
list project="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "{{project}}" ]; then
      echo "Projects:"
      for d in {{projects_dir}}/*/; do [ -d "$d" ] && echo "  - $(basename "$d")"; done
      exit 0
    fi
    proj="{{projects_dir}}/{{project}}"
    [ -d "$proj" ] || { echo "No such project: {{project}}" >&2; exit 1; }
    for col in "$proj"/*/; do
      [ -d "$col" ] || continue
      echo "▸ $(basename "$col")"
      shopt -s nullglob
      for f in "$col"*.md; do
        id=$(basename "$f" .md)
        title=$(sed -n 's/^title:[[:space:]]*//p' "$f" | head -n1)
        echo "    $id — $title"
      done
    done

# --- ticket lifecycle ----------------------------------------------------- #

# Create a ticket. ID is auto-generated (e.g. WEB-6).
# Usage: just new web-app todo "Fix the thing" [priority] [assignee] [labels]
#   priority: urgent|high|medium|low|none   labels: comma-separated, e.g. bug,auth
new project column title priority="none" assignee="" labels="":
    #!/usr/bin/env bash
    set -euo pipefail
    proj="{{projects_dir}}/{{project}}"
    col_dir="$proj/{{column}}"
    mkdir -p "$col_dir"

    # Reuse the id prefix already used in this project, else derive from its name.
    prefix=$(find "$proj" -name '*.md' ! -name 'project.md' -exec basename {} .md \; 2>/dev/null \
             | sed -nE 's/^([A-Za-z]+)-[0-9]+$/\1/p' | sort -u | head -n1)
    if [ -z "$prefix" ]; then
      prefix=$(echo "{{project}}" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z' | cut -c1-3)
      [ -z "$prefix" ] && prefix="TIX"
    fi

    max=$(find "$proj" -name '*.md' ! -name 'project.md' -exec basename {} .md \; 2>/dev/null \
          | sed -nE "s/^${prefix}-([0-9]+)$/\1/p" | sort -n | tail -n1)
    id="${prefix}-$(( ${max:-0} + 1 ))"
    file="$col_dir/${id}.md"

    if [ -n "{{labels}}" ]; then
      labels_fmt="[$(echo "{{labels}}" | sed 's/[[:space:]]*,[[:space:]]*/, /g')]"
    else
      labels_fmt="[]"
    fi

    cat > "$file" <<EOF
    ---
    title: {{title}}
    assignee: {{assignee}}
    priority: {{priority}}
    labels: $labels_fmt
    created: $(date +%F)
    ---

    EOF
    # Strip the leading indentation the recipe body requires.
    sed -i.bak 's/^    //' "$file" && rm -f "$file.bak"

    echo "Created $file"
    python3 build.py

# Move a ticket to another column: `just move web-app WEB-1 done`
move project id column:
    #!/usr/bin/env bash
    set -euo pipefail
    proj="{{projects_dir}}/{{project}}"
    src=$(find "$proj" -name '{{id}}.md' 2>/dev/null | head -n1)
    [ -n "$src" ] || { echo "Ticket {{id}} not found in {{project}}" >&2; exit 1; }
    dest_dir="$proj/{{column}}"
    mkdir -p "$dest_dir"
    dest="$dest_dir/{{id}}.md"
    if [ "$src" = "$dest" ]; then echo "{{id}} is already in {{column}}"; exit 0; fi
    if git rev-parse --git-dir >/dev/null 2>&1; then git mv -f "$src" "$dest"; else mv "$src" "$dest"; fi
    echo "Moved {{id}} → {{column}}"
    python3 build.py

# Delete a ticket: `just rm web-app WEB-1`
rm project id:
    #!/usr/bin/env bash
    set -euo pipefail
    proj="{{projects_dir}}/{{project}}"
    src=$(find "$proj" -name '{{id}}.md' 2>/dev/null | head -n1)
    [ -n "$src" ] || { echo "Ticket {{id}} not found in {{project}}" >&2; exit 1; }
    if git rev-parse --git-dir >/dev/null 2>&1 && git ls-files --error-unmatch "$src" >/dev/null 2>&1; then
      git rm -f "$src"
    else
      rm -f "$src"
    fi
    echo "Deleted {{id}}"
    python3 build.py

# Open a ticket in $EDITOR: `just edit web-app WEB-1`
edit project id:
    #!/usr/bin/env bash
    set -euo pipefail
    src=$(find "{{projects_dir}}/{{project}}" -name '{{id}}.md' 2>/dev/null | head -n1)
    [ -n "$src" ] || { echo "Ticket {{id}} not found in {{project}}" >&2; exit 1; }
    "${EDITOR:-vi}" "$src"

# --- project lifecycle ---------------------------------------------------- #

# Scaffold a new project with the default columns.
# Usage: just new-project mobile-app ["Display Name"]
new-project id name="":
    #!/usr/bin/env bash
    set -euo pipefail
    proj="{{projects_dir}}/{{id}}"
    [ -e "$proj" ] && { echo "Project {{id}} already exists" >&2; exit 1; }
    for col in todo in-progress in-qa done; do mkdir -p "$proj/$col"; done
    name="{{name}}"; [ -z "$name" ] && name=$(echo "{{id}}" | sed -E 's/[-_]+/ /g; s/\b(.)/\u\1/g')
    cat > "$proj/project.md" <<EOF
    ---
    name: $name
    columns: [todo, in-progress, in-qa, done]
    ---
    EOF
    sed -i.bak 's/^    //' "$proj/project.md" && rm -f "$proj/project.md.bak"
    echo "Created project $proj"
    python3 build.py
