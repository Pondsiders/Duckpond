"""Dynamic system prompt assembly.

Builds the complete system prompt from multiple sources:
- Eternal: The soul prompt from system-prompt.md
- Past: Capsule summaries (Postgres) + today so far (Redis)
- Present: Machine info + weather (Redis)
- Future: Calendar + todos (Redis)

Uses Jinja2 templates for clean separation of structure from data.
"""

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

import psycopg
import redis
from jinja2 import Environment, FileSystemLoader

# Paths
SOUL_PROMPT_PATH = Path("/Pondside/Alpha-Home/self/system-prompt/system-prompt.md")
TEMPLATES_DIR = Path(__file__).parent.parent.parent / "templates"

# Database connection
DATABASE_URL = os.environ.get("DATABASE_URL", "")
REDIS_HOST = os.environ.get("REDIS_HOST", "alpha-pi")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))


@dataclass
class MachineInfo:
    """Information about the current machine."""
    name: str
    cores: int
    ram: str
    gpu: str | None
    uptime: str
    disk_free: str


def get_machine_info() -> MachineInfo:
    """Gather information about the current machine."""
    import platform

    # Hostname
    name = platform.node().split(".")[0]

    # CPU cores
    cores = os.cpu_count() or 0

    # RAM
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    gb = kb / 1024 / 1024
                    ram = f"{gb:.0f}GB RAM"
                    break
            else:
                ram = "unknown"
    except Exception:
        ram = "unknown"

    # GPU (nvidia-smi)
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            gpu = result.stdout.strip().split("\n")[0]
        else:
            gpu = None
    except Exception:
        gpu = None

    # Uptime
    try:
        with open("/proc/uptime") as f:
            uptime_seconds = float(f.read().split()[0])
            days = int(uptime_seconds // 86400)
            hours = int((uptime_seconds % 86400) // 3600)
            if days > 0:
                uptime = f"{days}d {hours}h"
            else:
                uptime = f"{hours}h"
    except Exception:
        uptime = "unknown"

    # Disk free
    try:
        result = subprocess.run(
            ["df", "-h", "/"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            lines = result.stdout.strip().split("\n")
            if len(lines) >= 2:
                parts = lines[1].split()
                disk_free = f"{parts[3]} free"
            else:
                disk_free = "unknown"
        else:
            disk_free = "unknown"
    except Exception:
        disk_free = "unknown"

    return MachineInfo(
        name=name,
        cores=cores,
        ram=ram,
        gpu=gpu,
        uptime=uptime,
        disk_free=disk_free,
    )


def get_redis_value(r: redis.Redis, key: str) -> str | None:
    """Get a string value from Redis, or None if not found."""
    value = r.get(key)
    if value:
        return value.decode("utf-8") if isinstance(value, bytes) else value
    return None


@dataclass
class CapsuleSummary:
    """A Capsule summary with its time period."""
    period_start: str  # ISO timestamp
    period_end: str    # ISO timestamp
    summary: str

    def format_header(self) -> str:
        """Format a human-readable header for this summary period.

        Examples:
        - "Monday Jan 13 2026" (daytime)
        - "Monday night Jan 12-13 2026" (nighttime, spans midnight)
        """
        import pendulum

        # Parse and convert to local time
        start = pendulum.parse(self.period_start).in_timezone("America/Los_Angeles")
        end = pendulum.parse(self.period_end).in_timezone("America/Los_Angeles")

        # Check if this is a night period (10 PM to 6 AM local)
        is_night = start.hour >= 22 or start.hour < 6

        if is_night:
            # Night spans midnight: "Monday night Jan 12-13 2026"
            # The "night" is named after the day it started
            day_name = start.format("dddd")
            month = start.format("MMM")
            start_day = start.day
            end_day = end.day
            year = end.year
            return f"{day_name} night {month} {start_day}-{end_day} {year}"
        else:
            # Daytime: "Monday Jan 13 2026"
            return start.format("dddd MMM D YYYY")


def get_capsule_summaries() -> tuple[CapsuleSummary | None, CapsuleSummary | None]:
    """Get the two most recent Capsule summaries from Postgres.

    Returns (summary1, summary2) where:
    - summary1 is the second most recent (X-2)
    - summary2 is the most recent completed (X-1)
    """
    if not DATABASE_URL:
        return None, None

    try:
        with psycopg.connect(DATABASE_URL) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT period_start, period_end, summary
                    FROM cortex.summaries
                    ORDER BY period_start DESC
                    LIMIT 2
                """)
                rows = cur.fetchall()

                summaries = [
                    CapsuleSummary(
                        period_start=row[0].isoformat() if row[0] else "",
                        period_end=row[1].isoformat() if row[1] else "",
                        summary=row[2],
                    )
                    for row in rows
                ]

                if len(summaries) >= 2:
                    # rows[0] is most recent, rows[1] is second most recent
                    # We want chronological order: X-2, X-1
                    return summaries[1], summaries[0]
                elif len(summaries) == 1:
                    return None, summaries[0]
                else:
                    return None, None
    except Exception as e:
        print(f"[Duckpond] Error fetching Capsule summaries: {e}")
        return None, None


def load_eternal() -> str:
    """Load the soul prompt from file."""
    if SOUL_PROMPT_PATH.exists():
        return SOUL_PROMPT_PATH.read_text()
    return "You are Alpha."


def build_system_prompt(machine_info: MachineInfo | None = None) -> str:
    """Build the complete system prompt from all sources.

    Args:
        machine_info: Pre-computed machine info, or None to compute fresh.
                     Pass cached info to avoid recomputing on every call.

    Returns:
        The fully assembled system prompt.
    """
    # Load template
    env = Environment(loader=FileSystemLoader(TEMPLATES_DIR))
    template = env.get_template("system_prompt.jinja2")

    # Gather data
    eternal = load_eternal()

    # Machine info (compute if not provided)
    machine = machine_info or get_machine_info()

    # Redis data
    try:
        r = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)
        weather = get_redis_value(r, "hud:weather")
        calendar = get_redis_value(r, "hud:calendar")
        todos = get_redis_value(r, "hud:todos")
        summary3 = get_redis_value(r, "hud:summary3")  # Today so far
    except Exception as e:
        print(f"[Duckpond] Error connecting to Redis: {e}")
        weather = None
        calendar = None
        todos = None
        summary3 = None

    # Postgres data (Capsule summaries)
    summary1, summary2 = get_capsule_summaries()

    # Generate "today so far" header
    import pendulum
    now = pendulum.now("America/Los_Angeles")
    today_header = now.format("dddd MMM D YYYY") + " so far"

    # Render template
    return template.render(
        eternal=eternal,
        summary1=summary1,
        summary2=summary2,
        summary3=summary3,
        today_header=today_header,
        machine=machine,
        weather=weather,
        calendar=calendar,
        todos=todos,
    )


# Cache machine info at module load time
_cached_machine_info: MachineInfo | None = None


def get_cached_machine_info() -> MachineInfo:
    """Get machine info, computing and caching on first call."""
    global _cached_machine_info
    if _cached_machine_info is None:
        _cached_machine_info = get_machine_info()
    return _cached_machine_info
