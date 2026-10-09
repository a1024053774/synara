"""Private runtime discovery shared by the two operator entry points."""
import json
import os
from pathlib import Path
import stat
import subprocess

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DATA = Path.home() / "Library/Application Support/a2a-workbench"


def data_directory():
    return Path(os.environ.get("A2A_WORKBENCH_DATA_DIR", str(DEFAULT_DATA))).expanduser().resolve()


def process_identity(pid):
    env = {**os.environ, "LC_ALL": "C", "LANG": "C"}
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "lstart=", "-o", "command="],
        env=env,
        # Match the launcher's locale and UTF-8 decoding exactly.
        capture_output=True, encoding="utf-8", errors="replace", check=True,
    )
    return result.stdout.strip()


def read_owner(data):
    path = data / "workbench-process.json"
    if not path.exists():
        return None
    owner = json.loads(path.read_text(encoding="utf-8"))
    try:
        identity = process_identity(owner["pid"])
    except subprocess.CalledProcessError as error:
        if error.cmd[0] == "ps" and error.returncode == 1 and not error.stdout.strip():
            return None
        raise
    if identity != owner["identity"]:
        raise RuntimeError("工作台 PID 身份已改变；保留现场，不启动或停止其他进程。")
    return owner


def read_endpoint(data):
    path = data / "a2a-gates/endpoint.json"
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
        raise RuntimeError("endpoint.json 必须是当前用户拥有的 0600 普通文件。")
    endpoint = json.loads(path.read_text(encoding="utf-8"))
    owner = read_owner(data)
    if not owner or endpoint["desktopPid"] != owner["pid"] or endpoint["home"] != str(data):
        raise RuntimeError("门禁 endpoint 不属于当前工作台进程。")
    from urllib.parse import urlparse
    url = urlparse(endpoint["origin"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.path:
        raise RuntimeError("门禁 endpoint 必须是本机 IPv4 HTTP 地址。")
    return endpoint
