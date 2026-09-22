# laya_service — 把真实 Laya 接到小恐龙上

这一层只做一件事：把 `(状态文档, 类型化问题)` 交给 Laya，做**一次前向**，把
`choice / score / noul` 三类答案回传。游戏每帧调一次 `POST /predict`。

## 启动

```bash
# 1) 什么都不装也能跑（降级为阈值规则，链路完整）
python laya_service/server.py

# 2) 换端口
python laya_service/server.py --port 8766

# 3) 用真实 Laya（需要 torch，且首次要能访问 HuggingFace）
pip install -r laya_service/requirements.txt
python laya_service/server.py --model convaiinnovations/laya
python laya_service/server.py --subfolder multilingual      # 多语言 checkpoint
python laya_service/server.py --device cpu                  # 不指定则自动选
```

网络受限时走镜像：

```bash
HF_ENDPOINT=https://hf-mirror.com python laya_service/server.py
```

## 自检

```bash
curl http://127.0.0.1:8766/health
```

```json
{
  "ok": true,
  "engine": "laya",
  "layaInstalled": true,
  "stats": { "calls": 0, "errors": 0, "avgMs": 0 }
}
```

`engine` 只会是 `laya` 或 `fallback-rule`。**降级时会明确写出来**，不会伪装成模型。

## 请求 / 响应

请求：

```json
{
  "state": "T-Rex runner state, frame 421.\nGround speed 7.10 px/frame (max 13).\n...",
  "questions": {
    "action":       { "type": "choice", "instructions": "...", "criteria": { "NONE": "...", "JUMP": "...", "DUCK": "...", "DROP": "..." } },
    "urgency":      { "type": "score",  "instructions": "...", "criteria": ["完全安全", "...", "...", "...", "马上就要撞"] },
    "safe_to_idle": { "type": "noul",   "instructions": "...", "criteria": { "true": "...", "false": "..." } }
  }
}
```

响应：

```json
{
  "engine": "laya",
  "model": "laya-rl-agent",
  "action": { "label": "JUMP", "probs": [0.02, 0.91, 0.04, 0.03], "confidence": 0.68 },
  "urgency": { "value": 0.62, "score": 2.48, "levels": 5 },
  "safe_to_idle": { "label": "no", "p": 0.09 },
  "usage": { "input_tokens": 246, "output_tokens": 0 },
  "latencyMs": 33.1
}
```

## 形状上的两个坑

上游 Laya 对 `criteria` 的形状有硬要求，形状错了会直接抛异常：

| 类型 | `criteria` 形状 | 返回值 |
| --- | --- | --- |
| `choice` | `{ 选项: 说明 }` | `choice` + `probabilities` |
| `score` | **有序列表**（档位 0..k-1） | `score` = 档位期望值，需除以 `k-1` 归一到 0..1 |
| `noul` | 选项恒为 `[false, true]`；`criteria` 可选 `{false, true}` | `noul` = **P(true)** |

另外 `head_max_len` 限制了选项 prompt 的 token 预算（默认 256），
选项太多（比如 50+ 类）会被截断导致准确率骤降；本项目只有 4 个动作，不受影响。

## 为什么这个服务跑不满 60fps

一次前向 33ms（T4 实测），加上 HTTP 往返，一帧一个来回约 40–60ms，
也就是 16–25 帧/秒——游戏本身要 60 帧。这正好说明为什么
`brain/weights.json` 那个 5k 参数、单次前向 0.01ms 的小模型有存在价值：
把通用慢推理蒸馏成专用 System 1，才能把延迟压进帧预算。
