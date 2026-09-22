#!/usr/bin/env python3
"""
server.py —— 把真正的 Laya 决策引擎包成一个 HTTP 端点

职责很窄：收下 (state document, typed questions)，交给 Laya 做**单次前向**，
把三种类型的答案回传。小恐龙那边每一帧调一次。

    POST /predict
      { "state": "<状态文档文本或 JSON>",
        "questions": { "action": {"type":"choice", ...},
                       "urgency": {"type":"score", ...},
                       "safe_to_idle": {"type":"noul", ...} } }

      → { "engine": "laya",
          "action": {"label":"JUMP", "probs":[...], "confidence":0.62},
          "urgency": {"value":0.4, "score":1.6, "levels":5},
          "safe_to_idle": {"label":"no", "p":0.11},
          "usage": {"input_tokens": 231, "output_tokens": 0},
          "latencyMs": 33.1 }

关于依赖：
  * 真实 Laya 需要 `pip install laya`（会拉 torch/transformers），并且
    首次运行要从 HuggingFace 拉 checkpoint（convaiinnovations/laya）。
    网络受限的环境可以设 HF_ENDPOINT=https://hf-mirror.com 走镜像。
  * 装不上也不影响这个服务启动：会自动降级成 fallback-rule，
    用和本地阈值头一致的规则回答，保证前端链路能跑通。
    降级状态会明确写在响应的 engine 字段和 /health 里，不会伪装成 Laya。

用法：
  python laya_service/server.py                       # 默认 127.0.0.1:8766
  python laya_service/server.py --port 8766 --model convaiinnovations/laya
  python laya_service/server.py --subfolder multilingual
  python laya_service/server.py --force-fallback       # 强制降级，用来测链路
"""
from __future__ import annotations

import argparse
import json
import re
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ------------------------------------------------------------------ 真实 Laya
try:
    import laya as _laya  # noqa: N813

    HAVE_LAYA = True
    LAYA_IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - 取决于运行环境
    _laya = None
    HAVE_LAYA = False
    LAYA_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


class LayaEngine:
    """真实 Laya：一次前向回答所有 typed question。"""

    engine = "laya"

    def __init__(self, model_id: str, subfolder: str | None, device: str | None):
        self.model_id = model_id
        self.subfolder = subfolder
        self.device = device
        self.agent = None

    def load(self):
        if not HAVE_LAYA:
            raise RuntimeError(f"未能 import laya（{LAYA_IMPORT_ERROR}）")
        kwargs = {}
        if self.device:
            kwargs["device"] = self.device
        if self.subfolder:
            kwargs["subfolder"] = self.subfolder
        self.agent = _laya.load(self.model_id, **kwargs)
        return self

    def answer(self, state, questions):
        out = self.agent.system_one(state, questions)
        answers = out.get("answers", {})
        a = answers.get("action", {})
        u = answers.get("urgency", {})
        s = answers.get("safe_to_idle", {})
        order = list(questions["action"]["criteria"].keys())
        probs = [float(a.get("probabilities", {}).get(k, 0.0)) for k in order]
        levels = len(questions.get("urgency", {}).get("criteria", [])) or 5
        score = float(u.get("score", 0.0))
        return {
            "engine": self.engine,
            "model": out.get("model", self.model_id),
            "action": {
                "label": a.get("choice", "NONE"),
                "probs": probs,
                "confidence": float(a.get("confidence", 0.0)),
            },
            "urgency": {
                "value": score / max(1, levels - 1),
                "score": score,
                "levels": levels,
            },
            "safe_to_idle": {
                "label": "yes" if float(s.get("noul", 0.0)) >= 0.5 else "no",
                "p": float(s.get("noul", 0.0)),
            },
            "usage": out.get("usage", {}),
        }


# ------------------------------------------------------------------ 降级规则
OBSTACLE_RE = re.compile(
    r"^\s*\d+\.\s+(?P<type>[a-z ]+?)\s+x\s+(?P<size>\d+),\s*"
    r"top edge at y=(?P<y>-?\d+),\s*(?P<dx>-?\d+)\s*px ahead\s*\(~(?P<eta>\d+)\s*frames\)",
    re.MULTILINE,
)


class RuleFallback:
    """
    降级策略：解析状态文档，套一组阈值。
    它和 src/laya/heads.js 里的 RuleHead 是同一套逻辑，
    存在的意义是"Laya 装不上时前端仍可端到端跑通"，不是来冒充模型的。
    """

    engine = "fallback-rule"

    def __init__(self):
        self.air_hold = 0
        self.duck_hold = 0

    def answer(self, state, questions):
        text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
        runner_line = ""
        for line in text.splitlines():
            if line.startswith("Runner:"):
                runner_line = line
                break
        airborne = "airborne" in runner_line
        ducking = "ducking" in runner_line
        obstacles = [
            {
                "type": m.group("type").strip(),
                "size": int(m.group("size")),
                "y": int(m.group("y")),
                "dx": int(m.group("dx")),
                "eta": int(m.group("eta")),
            }
            for m in OBSTACLE_RE.finditer(text)
        ]

        action = "NONE"
        if airborne:
            action = "JUMP" if self.air_hold > 0 else "NONE"
            self.air_hold = max(0, self.air_hold - 1)
        elif obstacles:
            o = obstacles[0]
            low_bird = "pterodactyl" in o["type"] and o["y"] >= 90
            high_bird = "pterodactyl" in o["type"] and o["y"] < 90
            if high_bird:
                action = "DUCK" if o["eta"] <= 9 else "NONE"
            elif low_bird or "large" in o["type"]:
                if o["eta"] <= 11:
                    action = "JUMP"
                    self.air_hold = 18
            elif o["eta"] <= 10:
                action = "JUMP"
                self.air_hold = 10
        if ducking and action != "DUCK":
            self.duck_hold = 0

        order = list(questions["action"]["criteria"].keys())
        probs = [0.03] * len(order)
        probs[order.index(action)] = 0.91
        eta = obstacles[0]["eta"] if obstacles else 999
        urgency = max(0.0, min(1.0, 1.0 - eta / 45.0))
        return {
            "engine": self.engine,
            "model": "threshold-rule (laya 未安装，已降级)",
            "action": {"label": action, "probs": probs, "confidence": 0.91},
            "urgency": {"value": urgency, "score": urgency * 4, "levels": 5},
            "safe_to_idle": {"label": "no" if eta <= 12 else "yes", "p": 0.2 if eta <= 12 else 0.8},
            "usage": {"input_tokens": len(text) // 4, "output_tokens": 0},
        }


# ------------------------------------------------------------------ HTTP
BRIDGE = None
STATS = {"calls": 0, "errors": 0, "totalMs": 0.0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("content-length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] in ("/health", "/"):
            self._json(
                200,
                {
                    "ok": True,
                    "engine": BRIDGE.engine,
                    "model": getattr(BRIDGE, "model_id", BRIDGE.engine),
                    "layaInstalled": HAVE_LAYA,
                    "layaImportError": LAYA_IMPORT_ERROR,
                    "stats": {
                        "calls": STATS["calls"],
                        "errors": STATS["errors"],
                        "avgMs": round(STATS["totalMs"] / STATS["calls"], 3) if STATS["calls"] else 0,
                    },
                },
            )
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path.split("?")[0] != "/predict":
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
            state = payload.get("state", "")
            questions = payload.get("questions") or {}
            t0 = time.perf_counter()
            result = BRIDGE.answer(state, questions)
            dt = (time.perf_counter() - t0) * 1000
            STATS["calls"] += 1
            STATS["totalMs"] += dt
            result["latencyMs"] = round(dt, 3)
            self._json(200, result)
        except Exception as exc:  # pragma: no cover
            STATS["errors"] += 1
            self._json(
                500,
                {"error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()},
            )

    def log_message(self, fmt, *args):
        pass  # 静默，避免每帧刷屏


# ------------------------------------------------------------------ 入口
def main():
    global BRIDGE
    ap = argparse.ArgumentParser(description="Laya ↔ T-Rex runner bridge")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--model", default="convaiinnovations/laya")
    ap.add_argument("--subfolder", default=None, help="例如 multilingual")
    ap.add_argument("--device", default=None, help="cpu / cuda")
    ap.add_argument("--force-fallback", action="store_true", help="强制降级，用于测链路")
    args = ap.parse_args()

    if args.force_fallback or not HAVE_LAYA:
        if not HAVE_LAYA:
            print(f"[laya_service] 未安装 laya（{LAYA_IMPORT_ERROR}），降级为阈值规则。")
            print("[laya_service] 想用真实模型：pip install laya，并确保能访问 HuggingFace。")
        BRIDGE = RuleFallback()
    else:
        try:
            BRIDGE = LayaEngine(args.model, args.subfolder, args.device).load()
            print(f"[laya_service] 已加载 Laya：{args.model}"
                  f"{'/' + args.subfolder if args.subfolder else ''}")
        except Exception as exc:
            print(f"[laya_service] 加载 Laya 失败：{type(exc).__name__}: {exc}")
            print("[laya_service] 降级为阈值规则（engine 字段会说明这一点）。")
            BRIDGE = RuleFallback()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[laya_service] 监听 http://{args.host}:{args.port}   engine={BRIDGE.engine}")
    print(f"[laya_service] 健康检查： curl http://{args.host}:{args.port}/health")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
