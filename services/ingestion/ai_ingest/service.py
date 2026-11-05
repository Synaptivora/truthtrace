#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A · 服务层：connect / status / sync。

供 server.py 的 `/source/*` 路由调用，把「AI 驱动取数」能力暴露成三个动作。
返回结构严格遵循《A端推进·总结与下一步.md》§6 冻结的契约，B/C 可以照此对接：

    GET  /source/list                → { sources: [ {id,name,authorized,status,last_sync,count} ] }
    GET  /source/status?source=钉钉  → { source, authorized, status, detail, last_sync, count }
    POST /source/connect {"source"}  → { source, authorized, status, action, hint }
    POST /source/sync    {"source"}  → { source, synced, evidences: [Evidence...] }

「人工挑选导入」补充的三个动作（v0.8，纯新增，不改上面四个）：
    POST /source/conversations {"source","source_data"|上传文件}
        → { source, handle, conversations: [ {id,title,count,start,end} ], capability }
    POST /source/preview  {"source","handle","conversation_ids","time_start","time_end"}
        → { conversations: [ {id,title,total,total_in_range,truncated,messages:[...]} ] }
    POST /source/extract  {"source","handle","conversation_ids","time_start","time_end"}
        → { source, synced, conversations, messages, evidences: [Evidence...] }

精度口径（与工具真实能力一致，别在 UI 上吹）：
    · 会话粒度：钉钉 openConversationId / 微信 talker，可逐会话多选；
    · 时间粒度：底层记录精确到秒（钉钉 createTime、微信 create_time），
      前端按「日期 + 时分」筛选，A 侧按字符串时间戳过滤，不改变记录本身。

三条硬约束（来自 §5.3，踩过就很难查）：
  1. 路由分支必须排在 do_GET / do_POST 的兜底之前，否则被 200 + 服务说明吞掉；
  2. sync 必须受 single-flight 锁保护，否则多线程下 backend 内存态互相覆盖；
  3. sync 产出的 evidence 必须显式带 source（渠道取数不能落回「用户上传」）。
"""
import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from .backends import MockBackend, DingTalkBackend, WeChatBackend
from .tools import ToolRegistry
from .agent import MockAgent, OpenAIAgent
from .config import llm_config_from_env, has_llm_key, OpenAICompatibleClient
from . import evidence

DEFAULT_GOAL = "查王五和张三之间关于合作款、转账的沟通，找出承诺与履约差异"

# 渠道别名：前端可能传中文名，也可能传英文 id，统一归一到内部 id
ALIASES = {
    "mock": "mock", "演示": "mock", "demo": "mock",
    "钉钉": "dingtalk", "dingtalk": "dingtalk", "dws": "dingtalk",
    "微信": "wechat", "wechat": "wechat", "weixin": "wechat",
}

# 展示名：Evidence.source 用这个（B 的 prompt 会原样显示给用户）
DISPLAY = {"mock": "mock", "dingtalk": "钉钉", "wechat": "微信"}

CATALOG = [
    {"id": "mock", "name": "演示数据源", "auth": "none"},
    {"id": "dingtalk", "name": "钉钉", "auth": "dws 扫码登录"},
    {"id": "wechat", "name": "微信", "auth": "手机扫码抓 SQLCipher 密钥"},
]

# 单条 chat 证据的正文预算，默认值与 server.py 的 MAX_CONTENT_CHARS 对齐：
# 同一份聊天不管从哪个入口进来，裁剪口径必须一致，否则 UI 上会出现「上传只留前 3 万、
# 直读却给了全量」的错位；真实模型下全量那条必然爆上下文。
CHAT_CONTENT_CHARS = int(os.environ.get("MAX_CONTENT_CHARS", "30000"))


def _clip_bundle(bundle: list, budget: int, truncated: list[str]) -> list:
    """对一批证据里的 chat 正文按预算裁剪，并把被裁的证据名记进 truncated。

    图片证据（data URL）不裁：它不是「读不完的文本」，而是模型要看的内容，
    按字符切会直接破坏 base64。图片过大属于 B 那一跳的事。
    """
    for item in bundle:
        if item.get("kind") != "chat":
            continue
        content, cut, kept, total = evidence.clip_text(item.get("content") or "", budget)
        if cut:
            item["content"] = content
            item["name"] = f"{item.get('name') or '聊天记录'} [保留 {kept}/{total} 行]"
            truncated.append(item["name"])
    return bundle


def normalize_source(raw: str | None) -> str:
    if not raw:
        return "mock"
    key = str(raw).strip().lower()
    return ALIASES.get(key, ALIASES.get(str(raw).strip(), key))


def _backend_cls(source_id: str):
    return {"mock": MockBackend, "dingtalk": DingTalkBackend,
            "wechat": WeChatBackend}.get(source_id)


# 上传的渠道导出文件落在独立目录：与「超限原件下载」的 UPLOAD_DIR 分开，
# 否则还没导入的聊天库会被 /files/<id> 读到。
_HANDLE_ROOT = os.path.join(tempfile.gettempdir(), "synapse_source_handles")

# C 的 <input type="datetime-local"> 给的是 2026-11-01T09:30，钉钉/微信记录是
# 「2026-11-01 09:30:00」。统一成定长字符串后，才能用 < > 直接比（这也是底层真实精度）。
def _norm_time(value) -> str:
    s = str(value or "").strip().replace("T", " ").replace("/", "-")
    if not s:
        return ""
    if len(s) == 10:
        s += " 00:00:00"
    elif len(s) == 16:
        s += ":00"
    elif len(s) == 19:
        pass
    return s


def _time_in_range(t, start: str, end: str) -> bool:
    ts = _norm_time(t)
    if not ts:
        return True
    if start and ts < start:
        return False
    if end and ts > end:
        return False
    return True


def _short(value: str) -> str:
    """2026-11-01 00:00:00 → 2026-11-01（日期开始/结束的默认边界不必显示到秒）。"""
    s = _norm_time(value)
    return s[:10] if s else ""


_PAREN_RE = re.compile(r"[（(][^）)]*[）)]")


def _bare_name(name: str) -> str:
    """去掉昵称里的括号备注：「叶衍统（打🎾喊我）」→「叶衍统」。

    钉钉昵称可以随时改，括号备注是同一人最常见的差异来源；
    但这里只用于「没有稳定 id」时的兜底，不拿昵称当主键。
    """
    return _PAREN_RE.sub("", str(name or "")).strip()


def _sender_is_self(rec: dict, ident: dict) -> bool:
    flag = rec.get("is_self")
    if isinstance(flag, bool):
        return flag
    sid = str(rec.get("sender_id") or "")
    # 微信适配器把 is_outgoing 的消息 sender 一律写成「我」，这本身就是本人证据；
    # 钉钉记录一定带 sender_id，所以这条不会误伤钉钉。
    if not sid and _bare_name(rec.get("sender")) == "我":
        return True
    if ident.get("id") and sid:
        return sid == ident["id"]
    if ident.get("name") and rec.get("sender"):
        return _bare_name(rec.get("sender")) == _bare_name(ident["name"])
    return False


def _preview_message(rec: dict, ident: dict | None = None) -> dict:
    """预览用的消息：带上能渲染的最小信息，绝不把服务器绝对路径吐给浏览器。"""
    media = str(rec.get("media") or "")
    msg = {
        "seq": rec.get("seq"),
        "sender": rec.get("sender") or "未知",
        "sender_id": str(rec.get("sender_id") or ""),
        "self": _sender_is_self(rec, ident) if ident is not None else False,
        "time": _norm_time(rec.get("time")),
        "type": str(rec.get("type") or "text").lower(),
        "text": str(rec.get("text") or ""),
        "amount": str(rec.get("amount") or ""),
        "has_media": bool(media),
    }
    if msg["type"] == "image" and media:
        thumb = _thumbnail(media)
        if thumb:
            msg["image"] = thumb
    return msg


def _thumbnail(media: str, max_bytes: int = 2 * 1024 * 1024) -> str | None:
    """本地图片 → data URL，让预览真的能看到图（限 2MB，且只给 image 消息）。"""
    if media.startswith("data:"):
        return media
    try:
        if not os.path.isfile(media) or os.path.getsize(media) > max_bytes:
            return None
        mime, _ = mimetypes.guess_type(media)
        if not (mime or "").startswith("image/"):
            return None
        with open(media, "rb") as f:
            return f"data:{mime};base64,{base64.b64encode(f.read()).decode('ascii')}"
    except Exception:  # noqa: BLE001
        return None


from .handle_files import HandleFiles, guarded_handles

class SourceService:
    """渠道连接状态机 + sync 编排。

    状态是进程内内存态（ThreadingHTTPServer 多线程共享），所以 sync 必须 single-flight。
    """

    def __init__(self):
        self._handle_files = HandleFiles()
        self._lock = threading.Lock()          # 保护 _state / _busy / _store
        self._busy: dict[str, bool] = {}
        self._state: dict[str, dict] = {}
        self._store: dict[str, list] = {}      # source -> 上次 sync 的 evidences
        self._loaded: dict[str, object] = {}   # source -> 已 load 的 backend
        self._loaded_key: dict[str, tuple] = {}  # source -> (handle, source_data)
        self._handles: dict[str, str] = {}     # handle token -> 导出文件临时路径
        self._probe_cache: dict[str, tuple] = {}  # source -> (时间戳, 探测结果)
        self._self_cache: dict[str, tuple] = {}   # source -> (时间戳, 本人身份)
        # 「先列清单、后按勾选读取」的中间结果：列清单时已经把这段时间的消息翻完了，
        # 用户勾完再重新翻一遍纯属浪费（30 天要 20 多秒）。这里留 10 分钟，
        # 勾选后直接挑出选中的会话落盘。
        self._scans: dict[str, tuple[float, dict, dict]] = {}

    # ------------------------------------------------------------------ 状态
    def _ensure(self, source_id: str) -> dict:
        st = self._state.get(source_id)
        if st is None:
            st = {"authorized": False, "status": "not_connected",
                  "detail": "尚未连接", "last_sync": None, "count": 0,
                  "last_action": "", "checked_at": ""}
            self._state[source_id] = st
        return st

    def _probe_one_for_list(self, sid: str) -> dict:
        """list_sources 用的单渠道探测：单个渠道炸了只返回空，不影响整张列表。"""
        try:
            # 列表徽标必须和详情页同源：以前列表只读进程里的旧状态，于是会出现
            # 「卡片写未连接、点进去说已就绪」。探测有 30 秒缓存，代价可以接受。
            return self._probe(sid) if sid == "mock" else self._probe_cached(sid)
        except Exception:  # noqa: BLE001  列表绝不能因为某个渠道探测失败而整个 500
            return {}

    def list_sources(self) -> dict:
        # 渠道探测互相独立（dws 子进程 / 开一次微信库），
        # 串行要 3~6 秒，前端面板一直空转；并行后总耗时≈最慢的一个渠道（约 1~2 秒）。
        # _probe_cached 各自加锁读写缓存、互不共享可变状态，并发安全。
        sids = [c["id"] for c in CATALOG]
        with ThreadPoolExecutor(max_workers=max(1, len(sids))) as pool:
            probes = dict(zip(sids, pool.map(self._probe_one_for_list, sids)))

        out = []
        for c in CATALOG:
            sid = c["id"]
            with self._lock:
                st = self._merge_probe(self._ensure(sid), probes.get(sid) or {})
            out.append({
                "id": sid,
                "name": c["name"],
                "auth": c["auth"],
                "authorized": st["authorized"],
                "status": st["status"],
                "detail": st.get("detail", ""),
                "last_sync": st["last_sync"],
                "count": st["count"],
            })
        return {"sources": out}

    @staticmethod
    def _merge_probe(st: dict, probe: dict) -> dict:
        """把探测结果并进状态；不覆盖 last_sync/count（那是「取了多少」的事实）。"""
        if not probe:
            return st
        st["authorized"] = bool(probe.get("authorized"))
        st["status"] = probe.get("status") or st.get("status") or "not_connected"
        st["detail"] = probe.get("detail") or ""
        st["action"] = probe.get("action") or ""
        st["hint"] = probe.get("hint") or ""
        st["checked_at"] = probe.get("checked_at") or st.get("checked_at", "")
        return st

    def status(self, raw_source: str | None) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        if _backend_cls(sid) is None:
            return {"error": f"未知数据源 {raw_source}，可用：{list(ALIASES)}"}, 404
        # 每次都过一遍探测（30 秒缓存）：
        # 只对「从没探测过」的渠道探测，会让 dws token 过期、微信换密钥之后仍然显示已就绪。
        try:
            probe = self._probe_cached(sid)
        except Exception:  # noqa: BLE001
            probe = {}
        with self._lock:
            st = dict(self._merge_probe(self._ensure(sid), probe))
        return {"source": sid, **st}, 200

    # ------------------------------------------------------------------ 连接
    def connect(self, raw_source: str | None) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        if _backend_cls(sid) is None:
            return {"error": f"未知数据源 {raw_source}，可用：{list(ALIASES)}"}, 404

        probe = self._probe_cached(sid, force=True)
        with self._lock:
            st = self._ensure(sid)
            st.update({"authorized": probe["authorized"], "status": probe["status"],
                       "detail": probe["detail"]})
        return {"source": sid, **probe}, 200

    def _probe_cached(self, sid: str, force: bool = False) -> dict:
        """探测有成本（要起 dws 子进程、开一次微信库），缓存 30s：
        C 的导入页一打开就会查状态，不该每次都等子进程。"""
        now = time.time()
        with self._lock:
            hit = self._probe_cache.get(sid)
        if not force and hit and now - hit[0] < 30:
            return dict(hit[1])
        probe = self._probe(sid)
        probe["checked_at"] = time.strftime("%H:%M:%S")
        with self._lock:
            self._probe_cache[sid] = (now, dict(probe))
        return probe

    def _probe(self, sid: str) -> dict:
        """探测渠道是否可用。

        只做「能否在本机找到可用凭证/命令」的检查，**不替用户做授权**
        （扫码这件事由授权机制本身决定，只能人做，见总结文档 §2.1）。
        """
        if sid == "mock":
            return {"authorized": True, "status": "ready", "detail": "内置演示数据，无需凭证"}
        if sid == "dingtalk":
            dws = shutil.which("dws")
            if not dws:
                return {"authorized": False, "status": "need_auth",
                        "action": "dws auth login",
                        "hint": "未检测到 dws 命令行工具；安装后执行 `dws auth login` 扫码授权"}
            text = ""
            try:
                # 用 -f json 而不是纯文本：文本只有「登录/未登录」两种说法，
                # token 过期时它仍然可能返回成功，于是面板一路显示「已就绪」，
                # 用户点到「读取」才撞上 401。JSON 里带 authenticated / token_valid /
                # expires_at，这三项才真的能回答「现在还能不能取数」。
                r = subprocess.run([dws, "auth", "status", "-f", "json"],
                                   capture_output=True, timeout=8, text=True)
                text = (r.stdout or "").strip()
                payload = json.loads(text) if text.startswith("{") else {}
            except Exception as e:  # noqa: BLE001
                return {"authorized": False, "status": "need_auth",
                        "action": "dws auth login",
                        "hint": f"探测 dws 状态失败：{e}；请手动执行 `dws auth login`"}
            if payload:
                authed = bool(payload.get("authenticated"))
                valid = bool(payload.get("token_valid", authed))
                expires = str(payload.get("expires_at") or "")
                when = expires[:16].replace("T", " ")
                who = "@".join(x for x in (payload.get("user_name"), payload.get("corp_name")) if x)
                if authed and valid:
                    detail = f"dws 已登录{('：' + who) if who else ''}"
                    if when:
                        detail += f"（token 有效至 {when}）"
                    return {"authorized": True, "status": "ready", "detail": detail}
                if authed and not valid:
                    return {"authorized": False, "status": "need_auth",
                            "action": "dws auth login",
                            "detail": "dws 登录已过期",
                            "hint": (f"dws token 已失效（{when or '未知时间'} 到期），"
                                     "重新执行 `dws auth login` 扫码即可，不用重装")}
                return {"authorized": False, "status": "need_auth",
                        "action": "dws auth login",
                        "detail": "dws 未登录",
                        "hint": "dws 未登录，请扫码授权后重试"}
            # 老版本 dws 不认 -f json（输出被人读文本占了），退回文本判断，
            # 但要把「不知道 token 是否有效」说清楚，别假装确定。
            ok = "not logged" not in text.lower() and "未登录" not in text
            return ({"authorized": True, "status": "ready",
                     "detail": "dws 已登录（该版本不支持 JSON 状态，未校验 token 有效期）"}
                    if ok else
                    {"authorized": False, "status": "need_auth", "action": "dws auth login",
                     "detail": "dws 未登录",
                     "hint": "dws 未登录，请扫码授权后重试"})
        if sid == "wechat":
            cache = os.environ.get("SYNAPSE_WECHAT_KEY_CACHE") or os.path.join(
                os.environ.get("LOCALAPPDATA", tempfile.gettempdir()),
                "Synapse", "wechat_db_keys.json")
            if not os.path.isfile(cache):
                return {"authorized": False, "status": "need_auth",
                        "action": "python -m adapters.wechat_key_cache import",
                        "hint": "未找到微信密钥缓存；需关闭微信 → 手机扫码 → 抓取 SQLCipher 密钥（只做一次）"}
            # 缓存文件在 ≠ 密钥能用：换设备、改密码、重装微信之后旧密钥就解不开了。
            # 所以这里真的开一次库（读会话清单），打不开就照实报 need_auth。
            try:
                from . import wechat_live  # noqa: PLC0415
                info = wechat_live.verify_key()
            except Exception as exc:  # noqa: BLE001
                detail = getattr(exc, "detail", "") or str(exc)
                return {"authorized": False,
                        "status": getattr(exc, "status", "") or "need_auth",
                        "action": getattr(exc, "action", "") or "capture-key",
                        "detail": f"密钥缓存存在但用不了：{detail}",
                        "hint": getattr(exc, "hint", "")
                                or "重新抓一次密钥（python wechat_key_cache.py --verify 可先自检）"}
            return {"authorized": True, "status": "ready",
                    "detail": f"密钥可用：可读 {info['sessions']} 个会话"
                              f"（账号 {info['account'] or '未知'}）"}
        return {"authorized": False, "status": "unsupported", "detail": f"未支持的渠道 {sid}"}

    # ---------------------------------------------------------------- 本人身份
    def resolve_self(self, sid: str) -> dict:
        """判断「这些消息里哪条是我发的」。

        钉钉消息带 senderOpenDingTalkId，但 CLI 不会告诉你自己的 id；
        dws auth status 只给 userId + user_name。所以走
            auth status(user_id,user_name) → contact user search(openDingTalkId)
        两步对出来，缓存 10 分钟。

        拿不到就**返回空身份**，让前端把全部消息当「对方」显示，并允许手动指定——
        比拿「第一条消息的发送者」当本人要诚实得多（那会把别人说的话安到你头上）。
        """
        now = time.time()
        with self._lock:
            hit = self._self_cache.get(sid)
        if hit and now - hit[0] < 600:
            return dict(hit[1])

        ident = {"id": "", "name": "", "via": ""}
        if sid == "dingtalk":
            dws = shutil.which("dws")
            if dws:
                uid = uname = ""
                try:
                    st = subprocess.run([dws, "auth", "status", "-f", "json"],
                                        capture_output=True, text=True, timeout=20)
                    if st.returncode == 0:
                        payload = json.loads(st.stdout or "{}")
                        uid = str(payload.get("user_id") or "")
                        uname = str(payload.get("user_name") or "")
                except Exception:  # noqa: BLE001
                    pass
                if uid and uname:
                    ident.update({"id": "", "name": uname, "via": "auth-status"})
                    try:
                        sr = subprocess.run(
                            [dws, "contact", "user", "search", "--keyword", uname, "-f", "json"],
                            capture_output=True, text=True, timeout=25)
                        if sr.returncode == 0:
                            rows = (json.loads(sr.stdout or "{}") or {}).get("result") or []
                            for row in rows:
                                if str(row.get("userId") or "") == uid:
                                    ident["id"] = str(row.get("openDingTalkId") or "")
                                    ident["name"] = str(row.get("nick") or uname)
                                    ident["via"] = "contact-search"
                                    break
                    except Exception:  # noqa: BLE001
                        pass
        with self._lock:
            self._self_cache[sid] = (now, dict(ident))
        return ident

    # ------------------------------------------------- 「人工挑选导入」三个动作
    #
    # 与 sync 的分工（重要）：
    #   sync    = 给一句调查目标，让 agent 自己找相关窗口 → 适合「我不知道该看哪段」；
    #   extract = 用户已经在预览里挑好了会话和时间范围 → 按选择原样取，不做 AI 猜测。
    # 前者不能替代后者：AI 检索会漏掉用户知道但关键词命不中的对话，
    # 而法律/调查场景要的恰恰是「我指定的这一段必须完整进来」。

    def save_handle(self, data: bytes, filename: str | None = None) -> str | None:
        """把 C 上传的渠道导出文件落到临时目录，返回后续预览/抽取用的 handle。

        不直接复用 UPLOAD_DIR：那是「超限原件下载」的目录，语义不同，
        混在一起会让 /files/<id> 能读到还没被导入的聊天库。
        """
        if not data:
            return None
        token = uuid.uuid4().hex[:16]
        path = self._handle_files.save(data, filename)
        with self._lock:
            for old, stored in list(self._handles.items()):
                if self._handle_files.owned(stored) and not os.path.exists(stored):
                    self._handles.pop(old, None)
            self._handles[token] = path
        return token

    def discard_upload(self, handle):
        with self._lock:
            path = self._handles.get(handle)
            if not path or not self._handle_files.owned(path):
                return
            self._handles.pop(handle, None)
        self._handle_files.remove(path)

    def _register_path(self, path: str) -> str:
        """把服务器上已有的导出文件登记成 handle（直读模式先用它落地快照）。"""
        token = uuid.uuid4().hex[:16]
        with self._lock:
            self._handles[token] = path
        return token

    def _handle_path(self, handle: str | None) -> str | None:
        if not handle:
            return None
        with self._lock:
            return self._handles.get(handle)

    def _load_for(self, sid: str, handle: str | None, source_data: str | None):
        """load backend；同一 (handle, source_data) 复用已加载实例，避免每次预览都重解析。"""
        cls = _backend_cls(sid)
        if cls is None:
            return None, {"error": f"未知数据源 {sid}", "hint": f"可用：{list(ALIASES)}"}, 404
        path = self._handle_path(handle) or source_data
        key = (handle or "", source_data or "")
        with self._lock:
            cached = self._loaded.get(sid)
            cached_key = self._loaded_key.get(sid)
        if cached is not None and cached_key == key:
            return cached, None, 200
        backend = cls()
        try:
            backend.load(path)
        except SystemExit as e:
            detail = str(e).strip("[]! ")
            return None, {"status": "need_data", "detail": detail,
                          "hint": "请上传渠道导出的 JSON，或填写导出文件在服务器上的绝对路径"}, 400
        except Exception as e:  # noqa: BLE001
            return None, {"status": "error", "detail": f"读取导出文件失败: {e}"}, 500
        with self._lock:
            self._loaded[sid] = backend
            self._loaded_key[sid] = key
        return backend, None, 200

    @guarded_handles
    def conversations(self, raw_source: str | None, handle: str | None = None,
                      source_data: str | None = None) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        backend, err, code = self._load_for(sid, handle, source_data)
        if backend is None:
            return {"source": sid, **err}, code
        convs = backend.list_conversations()
        return {
            "source": sid,
            "display": DISPLAY.get(sid, sid),
            "handle": handle,
            "total": len(convs),
            "conversations": convs,
            "capability": {
                "select": "conversation",
                "time_range": True,
                "time_precision": "second",
                "note": "渠道原始记录精确到秒；界面按日期与时分筛选，筛选不改写记录本身",
            },
        }, 200

    def _sweep(self, dws: str, start: str, end: str, limit: int,
               page_cap: int, deadline: float) -> tuple[list, int, str, str, bool, str, list]:
        """拉一个时间窗内的全部消息页。返回 (rows, pages, earliest, latest, complete, stop)。

        rows = [(cid, title, singleChat, [message...]), ...]，去重交给调用方做——
        并行切窗时相邻窗口边界上的消息会重复出现，必须按 openMessageId 合并。
        """
        rows: list = []
        pages = 0
        earliest = ""
        latest = ""
        complete = False
        stop = ""
        cursor = "0"
        seen_cursors: set[str] = set()
        empty_streak = 0
        page_limit = max(1, min(limit, 100))
        page_sizes: list[int] = []
        while pages < page_cap:
            if time.time() > deadline:
                stop = "budget"
                break
            # 同一游标最多取 3 次：钉钉在突发并发下会回「偏小的页」（实测同一范围内
            # 一次 965 条、另一次只有 790 条，页数却一样）——那是被截断的页，不是真的没有。
            result = {}
            groups: list = []
            new_this_page = 0
            for attempt in range(3):
                cmd = [dws, "chat", "message", "list-all",
                       "--start", start, "--end", end,
                       "--limit", str(page_limit),
                       "--cursor", cursor, "-f", "json"]
                try:
                    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
                except Exception as exc:  # noqa: BLE001
                    stop = f"error: {exc}"
                    break
                if proc.returncode != 0:
                    stop = f"dws {proc.returncode}：{(proc.stderr or proc.stdout or '').strip()[:160]}"
                    break
                try:
                    payload = json.loads(proc.stdout or "{}")
                except json.JSONDecodeError:
                    stop = "bad json"
                    break
                if not payload.get("success", False):
                    stop = str(payload.get("errorMsg") or "dws 调用失败")
                    break
                result = payload.get("result") or {}
                groups = [g for g in (result.get("conversationMessagesList") or [])
                          if (g.get("messages") or [])]
                new_this_page = sum(len(g.get("messages") or []) for g in groups)
                stop = ""
                # 钉钉实际每页只给 ~50 条（--limit 100 也一样），所以「正常页」并不等于
                # page_limit；只有明显异常（近乎空页）才重取，否则每页都要多打 2 次。
                if new_this_page >= max(8, page_limit * 0.25) or not result.get("hasMore"):
                    break
                time.sleep(0.4 * (attempt + 1))
            if stop:
                break
            for group in groups:
                rows.append((group.get("openConversationId") or group.get("title") or "",
                             group.get("title") or "钉钉会话",
                             bool(group.get("singleChat")),
                             group.get("messages") or []))
                for message in group.get("messages") or []:
                    stamp = _norm_time(message.get("createTime"))
                    if stamp:
                        if not earliest or stamp < earliest:
                            earliest = stamp
                        if not latest or stamp > latest:
                            latest = stamp
            pages += 1
            page_sizes.append(new_this_page)
            # 空页会真的出现（第 2 页偶尔回 0 条，第 3 页又有），所以给 3 次容忍
            empty_streak = empty_streak + 1 if new_this_page == 0 else 0
            if empty_streak >= 3:
                stop = "empty"
                break
            nxt = str(result.get("nextCursor") or "0")
            if not result.get("hasMore") or nxt in ("", "0") or nxt == cursor or nxt in seen_cursors:
                complete = True
                break
            seen_cursors.add(cursor)
            cursor = nxt
        # 最后一页的顺序统计不进 rows 的语义，但留个尾巴给上层做诊断
        return rows, pages, earliest, latest, complete, stop, page_sizes

    @staticmethod
    def _split_range(start: str, end: str, chunks: int) -> list[tuple[str, str]]:
        """把 [start,end] 均分成 chunks 段，用于并行取数（顺序拼接后仍按时间去重排序）。"""
        try:
            t0 = time.mktime(time.strptime(start, "%Y-%m-%d %H:%M:%S"))
            t1 = time.mktime(time.strptime(end, "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            return [(start, end)]
        if t1 <= t0 or chunks <= 1:
            return [(start, end)]
        step = (t1 - t0) / chunks
        out = []
        for i in range(chunks):
            a = t0 + step * i
            b = t1 if i == chunks - 1 else t0 + step * (i + 1)
            out.append((time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(a)),
                        time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(b))))
        return out

    def _live_wechat(self, time_start: str | None = None,
                     time_end: str | None = None,
                     ids: list[str] | None = None) -> tuple[dict, int]:
        """微信直读：本机库 → Version 1 JSON 快照 → 同一套会话/预览/抽取。

        与钉钉的差别：微信是本地 SQLCipher 库，没有「翻页」概念，
        一次 get_messages(cid, start, end) 就是这段范围的全部消息；
        代价是首次解库约 7 秒，之后进程内复用实例（见 wechat_live._TTL）。
        """
        from . import wechat_live

        start, end = _norm_time(time_start), _norm_time(time_end)
        if not start or not end:
            return {"source": "wechat", "status": "need_range",
                    "error": "直读需要 time_start 与 time_end"}, 400
        try:
            data, info = wechat_live.snapshot(start, end, ids=ids)
        except wechat_live.WeChatLiveError as exc:
            out = {"source": "wechat", "status": exc.status,
                   "error": exc.detail, "detail": exc.detail}
            if exc.hint:
                out["hint"] = exc.hint
            if exc.action:
                out["action"] = exc.action
            return out, exc.code
        out_dir = tempfile.mkdtemp(prefix="synapse_wx_live_")
        path = os.path.join(out_dir, "export.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        handle = self._register_path(path)
        out, code = self.conversations("wechat", handle=handle)
        if code != 200:
            return out, code
        stamps = [m["timestamp"] for c in data.get("conversations") or [] for m in c["messages"]]
        out.update({
            "mode": "live", "handle": handle,
            "time_start": start, "time_end": end, "pages": 0,
            "scan": {
                "pages": 0, "windows": 1,
                "messages": info["messages"],
                "conversations": info["conversations"],
                "scanned": info["scanned"],
                "skipped": info["skipped"],
                "earliest": min(stamps) if stamps else "",
                "latest": max(stamps) if stamps else "",
                "complete": True, "stop": "",
                "media": info.get("media") or {},
            },
        })
        out["truncated"] = False
        return out, 200

    def _scan_dingtalk(self, dws: str, start: str, end: str,
                       limit: int, max_pages: int, budget: float,
                       ) -> tuple[dict, dict]:
        """按时间范围扫 `list-all`，合并成 cid → {title, singleChat, messages}。

        「列清单」和「读取」共用这一份扫描结果：前者只取骨架（标题/条数/起止），
        后者才把消息落盘成快照。翻页规则见下面 live() 的注释，别再退回 4 页。
        """
        merged: dict[str, dict] = {}
        pages = 0
        earliest = ""
        latest = ""
        total = 0
        complete = True
        stops: list[str] = []
        page_cap = max(1, min(max_pages, 200))
        page_limit = max(1, min(limit, 100))
        deadline = time.time() + max(10.0, budget)

        # 切窗并行：串行翻 30 天要 30 多秒，用户会以为卡死；按天数切 1~4 段并发翻页。
        try:
            span_days = (time.mktime(time.strptime(end, "%Y-%m-%d %H:%M:%S"))
                         - time.mktime(time.strptime(start, "%Y-%m-%d %H:%M:%S"))) / 86400
        except ValueError:
            span_days = 1
        # 短范围也别死等一条线：7 天 10 页串行要 20 多秒，切两窗就减半。
        workers = 1 if span_days <= 3 else min(4, int(span_days // 5) + 1)
        windows = self._split_range(start, end, workers)

        results: list = [None] * len(windows)
        if len(windows) == 1:
            results[0] = self._sweep(dws, start, end, page_limit, page_cap, deadline)
        else:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=len(windows)) as pool:
                futures = {pool.submit(self._sweep, dws, s, e, page_limit, page_cap, deadline): i
                           for i, (s, e) in enumerate(windows)}
                for future, idx in futures.items():
                    try:
                        results[idx] = future.result()
                    except Exception as exc:  # noqa: BLE001
                        results[idx] = ([], 0, "", "", False, f"error: {exc}", [])

        all_page_sizes: list = []
        for item in results:
            rows, pg, lo, hi, done, stop, sizes = item
            pages += pg
            all_page_sizes.extend(sizes or [])
            if not done:
                complete = False
                stops.append(stop)
            for cid, title, single, msgs in rows:
                bucket = merged.setdefault(cid, {
                    "openConversationId": cid,
                    "title": title,
                    "singleChat": single,
                    "messages": [],
                    "_seen": set(),
                })
                for message in msgs:
                    mid = message.get("openMessageId") or ""
                    if mid and mid in bucket["_seen"]:
                        continue
                    if mid:
                        bucket["_seen"].add(mid)
                    bucket["messages"].append(message)
                    stamp = _norm_time(message.get("createTime"))
                    if stamp:
                        if not earliest or stamp < earliest:
                            earliest = stamp
                        if not latest or stamp > latest:
                            latest = stamp
                    total += 1

        for bucket in merged.values():
            bucket.pop("_seen", None)
            bucket["messages"].sort(key=lambda m: _norm_time(m.get("createTime")))

        return merged, {
            "pages": pages,
            "windows": len(windows),
            "messages": total,
            "earliest": earliest,
            "latest": latest,
            "complete": complete,
            "stop": "; ".join(s for s in stops if s),
            "page_limit": page_limit,
            "page_sizes": all_page_sizes,
        }

    # ---- 列清单时的扫描结果：勾选后直接复用，不再翻一遍 ----
    _SCAN_TTL = 600.0

    def _remember_scan(self, sid: str, start: str, end: str,
                       merged: dict, scan: dict) -> None:
        key = f"{sid}|{start}|{end}"
        with self._lock:
            now = time.time()
            for k, (at, _m, _s) in list(self._scans.items()):
                if now - at > self._SCAN_TTL:
                    self._scans.pop(k, None)
            while len(self._scans) >= 4:      # 只留最近 4 份，别让消息堆在内存里
                oldest = min(self._scans, key=lambda k: self._scans[k][0])
                self._scans.pop(oldest, None)
            self._scans[key] = (now, merged, scan)

    def _recall_scan(self, sid: str, start: str, end: str):
        key = f"{sid}|{start}|{end}"
        with self._lock:
            item = self._scans.get(key)
            if not item:
                return None
            if time.time() - item[0] > self._SCAN_TTL:
                self._scans.pop(key, None)
                return None
            return item[1], item[2]

    def _fetch_dingtalk_images(self, sid: str, convs: list, out_dir: str) -> dict:
        """落快照前把钉钉图片真正下载下来（写 _local_media）。

        dws 只给 mediaId 和带签名的 OSS 地址；前者证据层读不了，后者在本机被
        网络策略挡住（实测 http 502 / https 超时）。缺了这一步，图片会退化成
        「未下载的媒体」文本占位——用户看到的就是「聊天记录里没有图片」。
        可用 SYNAPSE_DINGTALK_MEDIA=0 关掉（limits/budget 也可用环境变量调）。
        """
        if sid != "dingtalk":
            return {}
        if os.environ.get("SYNAPSE_DINGTALK_MEDIA", "1") == "0":
            return {}
        dws = shutil.which("dws")
        if not dws or not convs:
            return {}
        try:
            import dingtalk_to_synapse as dts  # noqa: PLC0415  懒加载：非钉钉链路不依赖它
        except Exception:  # noqa: BLE001
            return {}
        try:
            limit = int(os.environ.get("SYNAPSE_DINGTALK_MEDIA_LIMIT", "40"))
        except ValueError:
            limit = 40
        try:
            budget = float(os.environ.get("SYNAPSE_DINGTALK_MEDIA_BUDGET", "25"))
        except ValueError:
            budget = 25.0
        try:
            return dts.fetch_images(convs, os.path.join(out_dir, "_media"), dws,
                                    limit=max(0, limit), budget=budget)
        except Exception as exc:  # noqa: BLE001  下载失败绝不能拖垮整次读取
            return {"failed": 1, "error": str(exc)[:160], "seconds": 0.0}

    def _write_snapshot(self, sid: str, convs: list, start: str, end: str,
                        scan: dict) -> tuple[dict, int]:
        """把会话落成快照并注册 handle；直读与「按勾选读取」共用。"""
        out_dir = tempfile.mkdtemp(prefix="synapse_live_")
        media = self._fetch_dingtalk_images(sid, convs, out_dir)
        if media:
            # scan 会原样回给前端：让用户知道「图取回了几张、有几张没取到」
            scan = {**scan, "media": media}
        path = os.path.join(out_dir, "messages.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"conversationMessagesList": convs}, f, ensure_ascii=False)
        handle = self._register_path(path)
        out, code = self.conversations(sid, handle=handle)
        if code == 200:
            complete = bool(scan.get("complete", True))
            out.update({"mode": "live", "handle": handle, "scan": scan,
                        "truncated": not complete,
                        "time_start": start, "time_end": end,
                        "pages": scan.get("pages", 0)})
            if not complete:
                out["hint"] = ("部分内容没翻到底（" + str(scan.get("stop") or "")[:120]
                               + "），可点该行右侧的刷新按钮单独重读")
        return out, code

    def sessions(self, raw_source: str | None, time_start: str | None = None,
                 time_end: str | None = None, limit: int = 100,
                 max_pages: int = 60, budget: float = 120.0) -> tuple[dict, int]:
        """只列「这段时间里有消息的会话」，不落盘、不导入。

        为什么要先列：整批读 30 天要十几秒、几十段会话，而用户常常只想导入其中
        几个群。先给清单（每段条数 + 起止日期），勾完再按会话精确读取——
        没勾的群不会被再读一遍，也不会进证据。
        """
        sid = normalize_source(raw_source)
        start, end = _norm_time(time_start), _norm_time(time_end)
        if not start or not end:
            return {"error": "列会话需要 time_start 与 time_end", "status": "need_range"}, 400

        if sid == "wechat":
            from . import wechat_live
            try:
                rows, info = wechat_live.list_sessions()
            except wechat_live.WeChatLiveError as exc:
                out = {"source": sid, "status": exc.status,
                       "detail": exc.detail, "error": exc.detail}
                if exc.hint:
                    out["hint"] = exc.hint
                if exc.action:
                    out["action"] = exc.action
                return out, exc.code
            return {"source": sid, "status": "ok", "sessions": rows,
                    "scan": {"scanned": info["scanned"], "complete": True}}, 200

        if sid != "dingtalk":
            return {"source": sid, "status": "unsupported",
                    "detail": f"{DISPLAY.get(sid, sid)}暂不支持直接列会话"}, 400
        dws = shutil.which("dws")
        if not dws:
            return {"source": sid, "status": "need_auth", "detail": "未检测到 dws 命令行工具",
                    "action": "dws auth login"}, 400

        merged, scan = self._scan_dingtalk(dws, start, end, limit, max_pages, budget)
        self._remember_scan(sid, start, end, merged, scan)
        rows = []
        for bucket in merged.values():
            msgs = bucket["messages"]
            if not msgs:
                continue
            rows.append({
                "id": bucket["openConversationId"],
                "title": bucket["title"],
                "single": bool(bucket["singleChat"]),
                "count": len(msgs),
                "start": _norm_time(msgs[0].get("createTime")),
                "end": _norm_time(msgs[-1].get("createTime")),
            })
        rows.sort(key=lambda r: r["end"] or "", reverse=True)
        if not rows:
            if scan["stop"]:
                return {"source": sid, "status": "error",
                        "detail": f"向钉钉取数失败：{scan['stop'][:200]}",
                        "action": "dws auth login"}, 502
            return {"source": sid, "status": "empty",
                    "detail": "该时间范围内没有可读消息",
                    "hint": "换一个时间范围；或确认 dws 授权账号有权读取这些会话"}, 404
        return {"source": sid, "status": "ok", "sessions": rows, "scan": scan}, 200

    def live(self, raw_source: str | None, time_start: str | None = None,
             time_end: str | None = None, limit: int = 100,
             max_pages: int = 60, budget: float = 120.0,
             conversations: list | None = None) -> tuple[dict, int]:
        """免导出直读：按时间范围调用渠道 CLI，落成本地快照后走同一套预览/抽取。

        为什么值得做：让用户先导出文件再上传，是把工具的限制转嫁给用户。
        dws 既能列会话又能按 --start/--end 拉消息，就直接问它要——
        拉回来的快照仍走 dingtalk_to_synapse 适配器，证据形态与手动导入完全一致。

        翻页（踩过的坑，别再退回 4 页）：钉钉 `list-all` **每页最多约 100 条**
        （--limit 传 500 也只给 100），且是「从最新往前」分页，页内顺序还会跳
        （同一批会话先给最近的，再回头补更早的）。所以 4 页 ≈ 400 条 ≈ 聊得勤的
        组织只有最近两三天——正是「选了近 30 天却只看到最近 3 天」的根因。
        现在按 hasMore 一直翻到底；同时把范围切成几段并行翻页（串行 30 天要 30 多秒，
        切 3~4 段后约十几秒），并用时间预算兜住总耗时。
        """
        sid = normalize_source(raw_source)
        picked = [c for c in (conversations or [])
                  if isinstance(c, dict) and c.get("id")]
        if sid == "wechat":
            # 微信走本机库直读（wechat-ai-memory 的本地数据源），不再强迫用户先导出 JSON
            return self._live_wechat(time_start=time_start, time_end=time_end,
                                     ids=[str(c["id"]) for c in picked] or None)
        if sid != "dingtalk":
            return {"source": sid, "status": "unsupported",
                    "detail": f"{DISPLAY.get(sid, sid)}暂不支持免导出直读",
                    "hint": "请改用导出文件导入"}, 400
        dws = shutil.which("dws")
        if not dws:
            return {"source": sid, "status": "need_auth", "detail": "未检测到 dws 命令行工具",
                    "action": "dws auth login",
                    "hint": "安装 dws 并扫码登录后可免导出直读；或改用导出文件"}, 400
        start, end = _norm_time(time_start), _norm_time(time_end)
        if not start or not end:
            return {"error": "直读需要 time_start 与 time_end", "status": "need_range"}, 400

        # 用户勾了哪几段，就只读哪几段：按会话精确翻页比整批扫更快，
        # 没勾的群一条都不会读出来。
        wanted = {str(c["id"]) for c in picked}
        cached = self._recall_scan(sid, start, end)
        if picked and not cached and len(picked) <= 12:
            # 勾得少且没有缓存：按会话取（每段 1~3 页），比整批扫划算
            return self._live_dingtalk_picked(sid, dws, picked, start, end,
                                              limit, max_pages, budget)
        # 勾得多（或全选）走整批扫，扫完再按勾选过滤——几十个群逐个取反而更慢。

        if cached:
            # 清单刚扫过同一范围，消息已在内存里，直接挑出来（30 天也不必再翻一遍）
            merged, scan = cached
        else:
            merged, scan = self._scan_dingtalk(dws, start, end, limit, max_pages, budget)
            self._remember_scan(sid, start, end, merged, scan)
        stop_reason = scan["stop"]

        convs = [b for b in merged.values()
                 if b["messages"] and (not wanted or b["openConversationId"] in wanted)]
        # 并行切窗后合并顺序是「窗口顺序」，对用户毫无意义；按最后一条消息倒序，
        # 最近有动静的会话排在最前（否则刚聊过的群可能被挤到列表底部）。
        convs.sort(key=lambda c: _norm_time(c["messages"][-1].get("createTime")), reverse=True)
        if wanted:
            # 只挑了其中几段：覆盖范围与条数要按挑中的算，别把没选的也算进去
            stamps = [_norm_time(m.get("createTime")) for c in convs for m in c["messages"]]
            stamps = [s for s in stamps if s]
            scan = dict(scan)
            scan.update({"picked": len(wanted),
                         "messages": sum(len(c["messages"]) for c in convs),
                         "earliest": min(stamps) if stamps else "",
                         "latest": max(stamps) if stamps else ""})
        if not convs:
            if stop_reason:
                return {"source": sid, "status": "error",
                        "detail": f"向钉钉取数失败：{stop_reason[:200]}",
                        "action": "dws auth login",
                        "hint": "确认 dws 仍处于登录状态；或改用导出文件导入"}, 502
            if wanted:
                return {"source": sid, "status": "empty",
                        "detail": "选中的会话在这段时间里没有消息",
                        "hint": "换几段会话或放宽时间范围"}, 404
            return {"source": sid, "status": "empty",
                    "detail": "该时间范围内没有可读消息",
                    "hint": "换一个时间范围；或确认 dws 授权账号有权读取这些会话"}, 404

        out, code = self._write_snapshot(sid, convs, start, end, scan)
        if code == 200 and not scan["complete"]:
            # 把「这份快照到底覆盖到哪」如实告诉前端：用户看到「近 30 天」却只有
            # 最近几天时，必须是数据没取完就说没取完，而不是让他自己猜。
            out["hint"] = (
                f"只读到 {scan['earliest'] or '未知时间'} 起"
                f"（已翻 {scan['pages']} 页 / {scan['messages']} 条）仍未到范围起点："
                "数据量较大，建议缩小时间范围后重新读取"
            )
        return out, code

    def _live_dingtalk_picked(self, sid: str, dws: str, picked: list,
                              start: str, end: str, limit: int,
                              max_pages: int, budget: float) -> tuple[dict, int]:
        """只读用户勾中的那几段会话（按群/按单聊精确翻页，并行）。

        为什么不在整批扫描里过滤：整批扫 30 天要十几秒、还要翻几十页；
        而用户既然已经勾好了，按会话取只要每段 1~3 页，几秒就够，
        并且没勾的群不会被读出来——这也是「只有选中的群才读取记录」的落点。
        """
        from concurrent.futures import ThreadPoolExecutor

        page_cap = max(1, min(max_pages, 200))
        page_limit = max(1, min(limit, 100))
        deadline = time.time() + max(10.0, budget)

        def one(item: dict):
            cid = str(item.get("id") or "")
            title = str(item.get("title") or "钉钉会话")
            single = bool(item.get("single"))
            if single:
                msgs, pg, done, stop = self._sweep_aggregate(
                    dws, cid, start, end, page_limit, page_cap, deadline)
            else:
                msgs, pg, done, stop = self._sweep_group(
                    dws, cid, start, end, page_limit, page_cap, deadline)
            return {"openConversationId": cid, "title": title,
                    "singleChat": single, "messages": msgs}, pg, done, stop

        # 一条会话一次 CLI 调用；并行 6 路够快，再多会挤兑钉钉接口（会回偏小的页）。
        workers = max(1, min(6, len(picked)))
        out_rows: list = []
        pages = 0
        complete = True
        stops: list[str] = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for row, pg, done, stop in pool.map(one, picked):
                pages += pg
                if not done:
                    complete = False
                    stops.append(f"{row['title']}: {stop}")
                if row["messages"]:
                    row["messages"].sort(key=lambda m: _norm_time(m.get("createTime")))
                    out_rows.append(row)

        if not out_rows:
            return {"source": sid, "status": "empty",
                    "detail": "选中的会话在这段时间里没有消息",
                    "hint": "换一段会话或放宽时间范围"}, 404

        out_rows.sort(key=lambda c: _norm_time(c["messages"][-1].get("createTime")),
                      reverse=True)
        stamps = [_norm_time(m.get("createTime"))
                  for c in out_rows for m in c["messages"]]
        stamps = [s for s in stamps if s]
        scan = {
            "pages": pages,
            "windows": len(picked),
            "messages": sum(len(c["messages"]) for c in out_rows),
            "earliest": min(stamps) if stamps else "",
            "latest": max(stamps) if stamps else "",
            "complete": complete,
            "stop": "; ".join(stops),
            "picked": len(picked),
        }
        return self._write_snapshot(sid, out_rows, start, end, scan)

    # ---- 单会话重读：绕过 list-all 的「聚合截断」----
    @staticmethod
    def _cursor_to_time(cursor) -> str:
        """钉钉 nextCursor 是毫秒时间戳（实测 1793526721908 → 2026-11-01 17:52:01）。

        `--time` 只认 `YYYY-MM-DD HH:MM:SS`，不认毫秒（传数字会静默回空列表），
        所以翻页时必须自己转一次；转不出来就让调用方停下，别拿着空游标死循环。
        """
        try:
            ms = int(str(cursor).strip())
        except (TypeError, ValueError):
            return ""
        if ms < 10 ** 11:      # 秒级时间戳兼容
            ms *= 1000
        try:
            return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ms / 1000))
        except (OverflowError, OSError, ValueError):
            return ""

    def _sweep_group(self, dws: str, cid: str, start: str, end: str,
                     limit: int, page_cap: int, deadline: float,
                     ) -> tuple[list, int, bool, str]:
        """按单个会话翻页拉全（群聊 `chat message list --group`）。

        为什么必须单独做：`list-all` 是「多会话聚合分页」，一页里每个会话只带一批
        消息，翻到后面那个会话就滚出结果集了。实测「精神医学学院入党积极分子」
        在 30 天 list-all 里只剩 12 条，按群拉却有 27 条；用户就会觉得「只有几天」。
        """
        got: dict[str, dict] = {}
        pages = 0
        complete = False
        stop = ""
        cursor = start
        seen_cursors: set[str] = set()
        while pages < page_cap:
            if time.time() > deadline:
                stop = "budget"
                break
            cmd = [dws, "chat", "message", "list", "--group", cid,
                   "--time", cursor, "--limit", str(limit), "-f", "json"]
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            except Exception as exc:  # noqa: BLE001
                stop = f"error: {exc}"
                break
            if proc.returncode != 0:
                stop = f"dws {proc.returncode}：{(proc.stderr or proc.stdout or '').strip()[:160]}"
                break
            try:
                payload = json.loads(proc.stdout or "{}")
            except json.JSONDecodeError:
                stop = "bad json"
                break
            if not payload.get("success", False):
                stop = str(payload.get("errorMsg") or "dws 调用失败")
                break
            result = payload.get("result") or {}
            batch = result.get("messages") or []
            for message in batch:
                mid = str(message.get("openMessageId") or "")
                if not mid:
                    mid = f'{message.get("createTime")}|{message.get("senderName")}|{len(got)}'
                got.setdefault(mid, message)
            pages += 1
            nxt = str(result.get("nextCursor") or "0")
            if not batch or not result.get("hasMore") or nxt in ("", "0"):
                complete = True
                break
            if nxt in seen_cursors:
                complete = True
                break
            seen_cursors.add(nxt)
            nxt_time = self._cursor_to_time(nxt)
            if not nxt_time or nxt_time <= cursor:
                stop = "cursor"
                break
            if nxt_time > end:
                complete = True
                break
            cursor = nxt_time
        return list(got.values()), pages, complete, stop

    def _sweep_aggregate(self, dws: str, cid: str, start: str, end: str,
                         limit: int, page_cap: int, deadline: float,
                         ) -> tuple[list, int, bool, str]:
        """单聊兜底：`list-all` 只留这一个会话的消息（单聊量小，几页就够）。"""
        got: dict[str, dict] = {}
        pages = 0
        complete = False
        stop = ""
        cursor = "0"
        seen_cursors: set[str] = set()
        while pages < page_cap:
            if time.time() > deadline:
                stop = "budget"
                break
            cmd = [dws, "chat", "message", "list-all",
                   "--start", start, "--end", end,
                   "--limit", str(limit), "--cursor", cursor, "-f", "json"]
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            except Exception as exc:  # noqa: BLE001
                stop = f"error: {exc}"
                break
            if proc.returncode != 0:
                stop = f"dws {proc.returncode}"
                break
            try:
                payload = json.loads(proc.stdout or "{}")
            except json.JSONDecodeError:
                stop = "bad json"
                break
            if not payload.get("success", False):
                stop = str(payload.get("errorMsg") or "dws 调用失败")
                break
            result = payload.get("result") or {}
            for group in result.get("conversationMessagesList") or []:
                key = group.get("openConversationId") or group.get("title") or ""
                if key != cid:
                    continue
                for message in group.get("messages") or []:
                    mid = str(message.get("openMessageId") or "")
                    if not mid:
                        mid = f'{message.get("createTime")}|{message.get("senderName")}|{len(got)}'
                    got.setdefault(mid, message)
            pages += 1
            nxt = str(result.get("nextCursor") or "0")
            if not result.get("hasMore") or nxt in ("", "0") or nxt in seen_cursors:
                complete = True
                break
            seen_cursors.add(nxt)
            cursor = nxt
        return list(got.values()), pages, complete, stop

    @guarded_handles
    def refresh_conversation(self, raw_source: str | None, handle: str | None = None,
                             conversation_id: str | None = None,
                             title: str | None = None,
                             time_start: str | None = None,
                             time_end: str | None = None,
                             limit: int = 100, budget: float = 90.0,
                             ) -> tuple[dict, int]:
        """只把某一段会话重读一遍，写进新快照后返回这一段的最新预览。

        为什么不让用户「整个范围再读一次」：30 天全量要十几秒、还受每页 100 条限制；
        而用户真正怀疑的往往就是某一段（比如党校只有几天）。单会话按群翻页只碰
        这一段，几秒出来，也不会动到其他会话已经调好的逐条勾选。
        """
        sid = normalize_source(raw_source)
        if sid == "wechat":
            return self._refresh_wechat(handle=handle, conversation_id=conversation_id,
                                        title=title, time_start=time_start, time_end=time_end)
        if sid != "dingtalk":
            return {"source": sid, "status": "unsupported",
                    "detail": f"{DISPLAY.get(sid, sid)}暂不支持按会话重读",
                    "hint": "请用导出文件导入，或重新读取整个时间范围"}, 400
        cid = str(conversation_id or "").strip()
        if not cid:
            return {"error": "缺少 conversation_id", "status": "need_conversation"}, 400
        start, end = _norm_time(time_start), _norm_time(time_end)
        if not start or not end:
            return {"error": "重读需要 time_start 与 time_end", "status": "need_range"}, 400
        path = self._handle_path(handle)
        if not path or not os.path.exists(path):
            return {"source": sid, "status": "need_data",
                    "detail": "当前快照已失效（服务可能重启过），请重新读取时间范围"}, 400
        dws = shutil.which("dws")
        if not dws:
            return {"source": sid, "status": "need_auth", "detail": "未检测到 dws 命令行工具",
                    "action": "dws auth login"}, 400
        try:
            with open(path, encoding="utf-8") as f:
                snapshot = json.load(f)
        except Exception as exc:  # noqa: BLE001
            return {"source": sid, "status": "error", "detail": f"快照不可读：{exc}"}, 500
        groups = snapshot.get("conversationMessagesList") or []
        target = None
        for group in groups:
            if (group.get("openConversationId") or group.get("title") or "") == cid:
                target = group
                break
        single = bool((target or {}).get("singleChat"))
        label = (target or {}).get("title") or title or "该会话"

        deadline = time.time() + max(20.0, budget)
        page_limit = max(1, min(limit, 100))
        msgs, pages, complete, stop = self._sweep_group(
            dws, cid, start, end, page_limit, 60, deadline)
        mode = "group"
        if not msgs and single:
            # 单聊没有 openConversationId 可喂给 --group，退回聚合过滤（量小，几页够）
            left = max(5.0, deadline - time.time())
            msgs, more_pages, complete, stop = self._sweep_aggregate(
                dws, cid, start, end, page_limit, 12, time.time() + left)
            pages += more_pages
            mode = "aggregate"
        kept = [m for m in msgs if _time_in_range(m.get("createTime"), start, end)]
        if not kept:
            hint = ("这个会话在所选范围内没有读到消息"
                    if not stop else f"读取失败：{stop[:120]}")
            return {"source": sid, "status": "empty", "error": f"{label}：{hint}",
                    "detail": f"{label}：{hint}",
                    "hint": "确认时间范围后重试；若钉钉里确实没有更早的消息，重读也不会变多",
                    "scan": {"mode": mode, "pages": pages, "messages": 0,
                             "complete": complete, "stop": stop}}, 404
        kept.sort(key=lambda m: _norm_time(m.get("createTime")))
        before = len((target or {}).get("messages") or [])
        if target is None:
            target = {"openConversationId": cid, "title": label,
                      "singleChat": False, "messages": []}
            groups.append(target)
        target["messages"] = kept
        snapshot["conversationMessagesList"] = groups

        # 写新文件而不是原地改：handle 可能指向用户上传的原始导出文件，不能动。
        out_dir = tempfile.mkdtemp(prefix="synapse_dt_refresh_")
        # 重读同样要把这一段的图取回来，否则刷新后图片又变回占位文本
        media = self._fetch_dingtalk_images(sid, [target], out_dir)
        new_path = os.path.join(out_dir, "messages.json")
        with open(new_path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False)
        new_handle = self._register_path(new_path)

        prev, code = self.preview(sid, handle=new_handle, conversation_ids=[cid],
                                  time_start=start, time_end=end, limit=500)
        meta = None
        listing, lcode = self.conversations(sid, handle=new_handle)
        if lcode == 200:
            meta = next((c for c in listing.get("conversations") or [] if c["id"] == cid), None)
        return {
            "source": sid,
            "status": "ok" if code == 200 else "partial",
            "handle": new_handle,
            "conversation": meta,
            "preview": (prev.get("conversations") or [None])[0],
            "self": prev.get("self"),
            "scan": {
                "mode": mode,
                "pages": pages,
                "messages": len(kept),
                "before": before,
                "complete": complete,
                "stop": stop,
                "earliest": _norm_time(kept[0].get("createTime")),
                "latest": _norm_time(kept[-1].get("createTime")),
                "media": media,
            },
        }, 200

    def _refresh_wechat(self, handle: str | None = None,
                        conversation_id: str | None = None,
                        title: str | None = None,
                        time_start: str | None = None,
                        time_end: str | None = None) -> tuple[dict, int]:
        """微信的单会话重读：直接对本机库再查一次这一段，替换快照里的这条。"""
        from . import wechat_live

        cid = str(conversation_id or "").strip()
        if not cid:
            return {"error": "缺少 conversation_id", "status": "need_conversation"}, 400
        start, end = _norm_time(time_start), _norm_time(time_end)
        if not start or not end:
            return {"error": "重读需要 time_start 与 time_end", "status": "need_range"}, 400
        path = self._handle_path(handle)
        if not path or not os.path.exists(path):
            return {"source": "wechat", "status": "need_data",
                    "error": "当前快照已失效（服务可能重启过），请重新读取时间范围"}, 400
        try:
            with open(path, encoding="utf-8") as f:
                snapshot = json.load(f)
        except Exception as exc:  # noqa: BLE001
            return {"source": "wechat", "status": "error", "error": f"快照不可读：{exc}"}, 500
        try:
            rows = wechat_live.conversation_messages(cid, start, end)
        except wechat_live.WeChatLiveError as exc:
            out = {"source": "wechat", "status": exc.status, "error": exc.detail}
            if exc.hint:
                out["hint"] = exc.hint
            return out, exc.code
        label = title or "微信会话"
        convs = snapshot.get("conversations") or []
        target = next((c for c in convs if (c.get("id") or c.get("name")) == cid), None)
        before = len((target or {}).get("messages") or [])
        if not rows:
            return {"source": "wechat", "status": "empty",
                    "error": f"{label}：这个范围内没有读到消息",
                    "hint": "确认时间范围后重试"}, 404
        if target is None:
            target = {"id": cid, "name": label, "kind": "group", "messages": []}
            convs.append(target)
        target["messages"] = rows
        snapshot["conversations"] = convs
        out_dir = tempfile.mkdtemp(prefix="synapse_wx_refresh_")
        new_path = os.path.join(out_dir, "export.json")
        with open(new_path, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False)
        new_handle = self._register_path(new_path)
        prev, code = self.preview("wechat", handle=new_handle, conversation_ids=[cid],
                                  time_start=start, time_end=end, limit=500)
        meta = None
        listing, lcode = self.conversations("wechat", handle=new_handle)
        if lcode == 200:
            meta = next((c for c in listing.get("conversations") or [] if c["id"] == cid), None)
        return {
            "source": "wechat",
            "status": "ok" if code == 200 else "partial",
            "handle": new_handle,
            "conversation": meta,
            "preview": (prev.get("conversations") or [None])[0],
            "scan": {"mode": "local", "pages": 0, "messages": len(rows), "before": before,
                     "complete": True, "stop": "",
                     "earliest": rows[0]["timestamp"], "latest": rows[-1]["timestamp"]},
        }, 200

    @guarded_handles
    def preview(self, raw_source: str | None, handle: str | None = None,
                source_data: str | None = None, conversation_ids=None,
                time_start: str | None = None, time_end: str | None = None,
                limit: int = 160) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        backend, err, code = self._load_for(sid, handle, source_data)
        if backend is None:
            return {"source": sid, **err}, code
        wanted = [str(c) for c in (conversation_ids or [])]
        s, e = _norm_time(time_start), _norm_time(time_end)
        ident = self.resolve_self(sid)
        out = []
        for conv in backend.conversations:
            if wanted and conv["id"] not in wanted:
                continue
            records = [r for r in conv["records"] if _time_in_range(r.get("time"), s, e)]
            if not records:
                continue
            # 发送者花名册：前端「我是谁」下拉要用，也用于在识别失败时让人手动指定
            tally: dict[tuple[str, str], int] = {}
            self_keys: set[tuple[str, str]] = set()
            for rec in records:
                key = (str(rec.get("sender_id") or ""), str(rec.get("sender") or "未知"))
                tally[key] = tally.get(key, 0) + 1
                if _sender_is_self(rec, ident):
                    self_keys.add(key)
            senders = [{"id": k[0], "name": k[1], "count": n, "self": k in self_keys}
                       for k, n in sorted(tally.items(), key=lambda kv: -kv[1])]
            out.append({
                "id": conv["id"],
                "title": conv["title"],
                "source": conv.get("source") or DISPLAY.get(sid, sid),
                "total": len(conv["records"]),
                "total_in_range": len(records),
                "truncated": len(records) > limit,
                "messages": [_preview_message(r, ident) for r in records[:limit]],
                "senders": senders,
            })
        return {"source": sid, "time_start": s, "time_end": e,
                "self": ident, "conversations": out}, 200

    @guarded_handles
    def extract(self, raw_source: str | None, handle: str | None = None,
                source_data: str | None = None, conversation_ids=None,
                time_start: str | None = None, time_end: str | None = None,
                max_evidence: int = 30, exclude: dict | None = None,
                max_chars: int | None = None) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        backend, err, code = self._load_for(sid, handle, source_data)
        if backend is None:
            return {"source": sid, **err}, code
        wanted = [str(c) for c in (conversation_ids or [])]
        if not wanted:
            return {"error": "请至少选择一个会话", "status": "need_selection"}, 400
        s, e = _norm_time(time_start), _norm_time(time_end)

        bundle: list = []
        picked = 0
        messages = 0
        skipped = []
        truncated_chars: list[str] = []
        # 与 /parse 用同一套字符预算：同一份聊天，从「上传」进和从「从钉钉读取」进，
        # 不能一个有预算、一个没有——否则真实模型下 30 天的大群必然爆上下文。
        char_budget = CHAT_CONTENT_CHARS if max_chars is None else max(1000, int(max_chars))
        # exclude: {convId: [seq...]} —— 用户在预览里逐条取消勾选的消息。
        # 用「排除」而不是「包含」，是为了让「默认全选」的语义在数据被截断时也不丢消息。
        drop = {str(k): {str(x) for x in (v or [])} for k, v in (exclude or {}).items()}
        for conv in backend.conversations:
            if conv["id"] not in wanted:
                continue
            records = [r for r in conv["records"] if _time_in_range(r.get("time"), s, e)]
            if not records:
                skipped.append({"id": conv["id"], "title": conv["title"], "reason": "时间范围内没有消息"})
                continue
            banned = drop.get(str(conv["id"])) or drop.get(conv["id"]) or set()
            if banned:
                total_before = len(records)
                records = [r for r in records if str(r.get("seq")) not in banned]
                if not records:
                    skipped.append({"id": conv["id"], "title": conv["title"],
                                    "reason": f"该会话 {total_before} 条消息都被取消勾选"})
                    continue
            # 名字里写**这段自己**的首末消息时间，而不是用户选的范围：
            # 选「7月~9月」时，8 月那段若也写 7月~9月，会让人以为它真的有 7 月的内容。
            span = f"{_short(records[0].get('time')) or '最早'}~{_short(records[-1].get('time')) or '最新'}"
            name = f"{conv['title']} · {span}（{len(records)} 条）"
            # 显式传 source：渠道取数不能落回「用户上传」，否则溯源失真
            label = "演示数据" if conv.get("source") == "mock" else (
                conv.get("source") or DISPLAY.get(sid, sid))
            bundle.extend(_clip_bundle(
                evidence.build_chat_bundle(records, name=name, source=label),
                char_budget, truncated_chars))
            picked += 1
            messages += len(records)

        if not bundle:
            return {"source": sid, "status": "empty", "synced": 0, "evidences": [],
                    "hint": "所选会话在该时间范围内没有消息，请放宽时间范围", "skipped": skipped}, 200

        truncated = False
        if max_evidence and len(bundle) > max_evidence:
            # 超额时保留前面的整段（chat + 它的媒体），并在返回里明说被裁剪，
            # 绝不让用户以为「导进来的就是全部」。默认上限已放宽到 200，
            # 正常导入不会触发；触发时说明一次选的会话确实太多了。
            truncated = True
            bundle = bundle[:max_evidence]

        errs = [e for ev in bundle for e in evidence.validate_evidence(ev)]
        with self._lock:
            # 只更新「上次取数」事实，不改授权态：extract 没探测凭证，
            # 替它写成 authorized=True 会让 /source/status 谎报渠道已授权。
            st = self._ensure(sid)
            st.update({"last_action": f"已导入 {len(bundle)} 条证据",
                       "last_sync": time.strftime("%Y-%m-%d %H:%M:%S"),
                       "count": len(bundle)})
            self._store[sid] = bundle

        out = {"source": sid, "synced": len(bundle), "conversations": picked,
               "messages": messages, "evidences": bundle, "time_start": s, "time_end": e}
        if truncated:
            out["truncated"] = True
            out["note"] = f"证据超过 {max_evidence} 条，已保留前 {max_evidence} 条；减少会话或缩小时间范围可完整导入"
        if skipped:
            out["skipped"] = skipped
        if truncated_chars:
            # 正文按预算裁过的证据（name 里已带 [保留 x/y 行]），前端据此提示「只读到一部分」
            out["truncated_chars"] = truncated_chars
        if errs:
            out["validation_errors"] = errs
        return out, 200

    # ------------------------------------------------------------------ 同步
    def sync(self, raw_source: str | None, goal: str | None = None,
             source_data: str | None = None, mode: str = "auto",
             max_windows: int = 8) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        cls = _backend_cls(sid)
        if cls is None:
            return {"error": f"未知数据源 {raw_source}，可用：{list(ALIASES)}"}, 404

        # single-flight：并发 sync 返回 busy，而不是让后端内存态互相覆盖
        with self._lock:
            if self._busy.get(sid):
                return {"source": sid, "status": "busy",
                        "hint": "上一次同步尚未结束，请稍后重试"}, 409
            self._busy[sid] = True

        try:
            backend = cls()
            try:
                backend.load(source_data)
            except SystemExit as e:
                with self._lock:
                    self._ensure(sid).update(
                        {"authorized": False, "status": "need_data",
                         "detail": str(e).strip("[]! ")})
                return {"source": sid, "status": "need_data",
                        "detail": str(e).strip("[]! "),
                        "hint": "请在请求体带 source_data（导出 JSON 的绝对路径）"}, 400
            except Exception as e:  # noqa: BLE001
                return {"source": sid, "status": "error", "detail": f"取数失败: {e}"}, 500

            reg = ToolRegistry()
            reg.add(backend)

            cfg = llm_config_from_env()
            use_llm = (mode in ("auto", "llm")) and mode != "mock" and has_llm_key(cfg)
            agent = (OpenAIAgent(OpenAICompatibleClient(cfg), reg) if use_llm
                     else MockAgent(reg))

            # ToolRegistry 以后端的 source 属性为 key（钉钉/微信/mock），
            # 传英文 id 会让 registry.call 返回「未知数据源」，这里必须传 backend.source。
            windows = agent.run(goal or DEFAULT_GOAL, sources=[backend.source],
                                max_windows=max_windows)

            bundle: list = []
            for i, w in enumerate(windows):
                title = w.get("conv_title") or w.get("conv_id") or "会话"
                name = f"{title} · 聚焦#{i + 1} (center seq {w.get('center_seq')})"
                # window 自带 source（来自 backend），落进 Evidence.source 才是诚实的溯源
                bundle.extend(evidence.build_chat_bundle(
                    w["records"], name=name,
                    source=w.get("source") or DISPLAY.get(sid, sid)))

            errs = []
            for ev in bundle:
                errs.extend(evidence.validate_evidence(ev))

            with self._lock:
                st = self._ensure(sid)
                # detail 留给「渠道可用性」（由探测写），这里只记「这次取到了什么」，
                # 否则下次探测会把「已同步 3 个窗口」覆盖掉，用户以为同步记录丢了。
                st.update({"authorized": True, "status": "ready",
                           "last_action": f"已同步 {len(windows)} 个聚焦窗口",
                           "last_sync": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "count": len(bundle)})
                self._store[sid] = bundle

            out = {"source": sid, "synced": len(bundle), "evidences": bundle,
                   "windows": len(windows), "agent": type(agent).__name__}
            if errs:
                out["validation_errors"] = errs
            return out, 200
        finally:
            with self._lock:
                self._busy[sid] = False

    def last_evidences(self, raw_source: str | None) -> list:
        with self._lock:
            return list(self._store.get(normalize_source(raw_source), []))
