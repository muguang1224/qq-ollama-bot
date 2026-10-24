#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
YOLO 推理 —— 供 Node 调用。

用法:
  python yolo.py detect  <图片>    物体检测（COCO 80 类）
  python yolo.py pose    <图片>    人体姿态（检测有没有人 / 几个人）
  python yolo.py cls     <图片>    图像分类（ImageNet 1000 类）
  python yolo.py all     <图片>    三项都跑

输出 JSON 到 stdout，Node 侧解析。

设计要点：
  - 用 onnxruntime CPU 推理（本机没有 CUDA provider）
  - 模型缺失或推理失败都输出 {ok:false, error:...}，不让调用方崩溃
  - 中文类别名（常用部分，其余保留英文）
"""
import json
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

import numpy as np
import cv2
import onnxruntime as ort

MODELS = {
    'detect': 'yolo11n.onnx',
    'pose': 'yolo11n-pose.onnx',
    'cls': 'yolo11n-cls.onnx',
}

# COCO 80 类的中文名（常用部分）
COCO_CN = {
    'person': '人', 'bicycle': '自行车', 'car': '汽车', 'motorcycle': '摩托车',
    'airplane': '飞机', 'bus': '公交车', 'train': '火车', 'truck': '卡车', 'boat': '船',
    'bird': '鸟', 'cat': '猫', 'dog': '狗', 'horse': '马', 'sheep': '羊', 'cow': '牛',
    'elephant': '大象', 'bear': '熊', 'zebra': '斑马', 'giraffe': '长颈鹿',
    'backpack': '背包', 'umbrella': '伞', 'handbag': '手提包', 'tie': '领带',
    'suitcase': '行李箱', 'frisbee': '飞盘', 'skis': '滑雪板', 'snowboard': '滑雪板',
    'sports ball': '球', 'kite': '风筝', 'baseball bat': '棒球棒', 'skateboard': '滑板',
    'surfboard': '冲浪板', 'bottle': '瓶子', 'wine glass': '酒杯', 'cup': '杯子',
    'fork': '叉子', 'knife': '刀', 'spoon': '勺子', 'bowl': '碗',
    'banana': '香蕉', 'apple': '苹果', 'sandwich': '三明治', 'orange': '橙子',
    'broccoli': '西兰花', 'carrot': '胡萝卜', 'hot dog': '热狗', 'pizza': '披萨',
    'donut': '甜甜圈', 'cake': '蛋糕', 'chair': '椅子', 'couch': '沙发',
    'potted plant': '盆栽', 'bed': '床', 'dining table': '餐桌', 'toilet': '马桶',
    'tv': '电视', 'laptop': '笔记本电脑', 'mouse': '鼠标', 'remote': '遥控器',
    'keyboard': '键盘', 'cell phone': '手机', 'microwave': '微波炉', 'oven': '烤箱',
    'toaster': '烤面包机', 'sink': '水槽', 'refrigerator': '冰箱', 'book': '书',
    'clock': '时钟', 'vase': '花瓶', 'scissors': '剪刀', 'teddy bear': '泰迪熊',
    'hair drier': '吹风机', 'toothbrush': '牙刷',
}

COCO = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
    'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
    'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
    'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
    'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
    'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup',
    'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
    'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
    'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
    'toothbrush',
]


def load_img(path, size=640):
    """
    读图并做 letterbox 到 size×size。

    为什么不用 cv2.imread 读 GIF：
      实测 cv2 能"读"GIF 但结果不可靠 —— 500x500 的动画表情
      被读成 4 通道，且推理结果全错（把动漫角色识别成"时钟"）。
      Pillow 读 GIF 稳定得多，所以统一用 Pillow 读、转 RGB、再交给 cv2 缩放。
    """
    from PIL import Image
    try:
        im = Image.open(path)
        # GIF/WebP 动图只取第一帧
        if getattr(im, 'n_frames', 1) > 1:
            im.seek(0)
        # 有透明通道时贴到白底，避免透明区变成黑色干扰识别
        if im.mode in ('RGBA', 'LA', 'P'):
            im = im.convert('RGBA')
            bg = Image.new('RGB', im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert('RGB')
        img = np.array(im)                      # RGB
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    except Exception:
        # 退回 cv2
        img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if img is None:
            return None
        if img.ndim == 3 and img.shape[2] == 4:
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        elif img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

    if img is None:
        return None

    h, w = img.shape[:2]
    scale = size / max(h, w)
    nh, nw = int(round(h * scale)), int(round(w * scale))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    top = (size - nh) // 2
    left = (size - nw) // 2
    canvas[top:top + nh, left:left + nw] = resized
    return canvas, scale, left, top, w, h


def nms(boxes, scores, iou_thres=0.45):
    """非极大值抑制 —— 去掉同一个物体的重复框。

    不加这个的话，一个人会被检出 5 次（实测过）。
    """
    if not len(boxes):
        return []
    boxes = np.asarray(boxes, dtype=np.float32)
    scores = np.asarray(scores, dtype=np.float32)

    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    order = scores.argsort()[::-1]

    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        idx = np.where(iou <= iou_thres)[0]
        order = order[idx + 1]
    return keep


def run_detect(path, conf_thres=0.35):
    mp = MODELS['detect']
    if not os.path.exists(mp):
        return {'ok': False, 'error': '模型不存在: ' + mp}
    got = load_img(path, 640)
    if got is None:
        return {'ok': False, 'error': '读不了图片'}
    canvas, scale, left, top, ow, oh = got

    blob = canvas[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
    blob = np.expand_dims(blob, 0)

    sess = ort.InferenceSession(mp, providers=['CPUExecutionProvider'])
    out = sess.run(None, {sess.get_inputs()[0].name: blob})[0]  # (1,84,N)

    pred = out[0].T  # (N,84): 4 box + 80 class
    scores = pred[:, 4:]
    cls_ids = scores.argmax(1)
    confs = scores[np.arange(len(scores)), cls_ids]

    keep = confs > conf_thres
    pred, cls_ids, confs = pred[keep], cls_ids[keep], confs[keep]

    objs = []
    if len(pred):
        # xywh → xyxy（还原到原图坐标）
        cx, cy, bw, bh = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
        x1 = (cx - bw / 2 - left) / scale
        y1 = (cy - bh / 2 - top) / scale
        x2 = (cx + bw / 2 - left) / scale
        y2 = (cy + bh / 2 - top) / scale
        boxes = np.stack([x1, y1, x2, y2], 1)

        # 每个类别单独做 NMS（不同类的框不该互相抑制）
        for cid in np.unique(cls_ids):
            sel = np.where(cls_ids == cid)[0]
            for k in nms(boxes[sel], confs[sel]):
                i = sel[k]
                name = COCO[cls_ids[i]] if cls_ids[i] < len(COCO) else str(cls_ids[i])
                objs.append({
                    'name': name,
                    'nameCn': COCO_CN.get(name, name),
                    'conf': round(float(confs[i]), 3),
                    'box': [round(float(max(0, boxes[i][0]))), round(float(max(0, boxes[i][1]))),
                            round(float(min(ow, boxes[i][2]))), round(float(min(oh, boxes[i][3])))],
                })

    objs.sort(key=lambda o: -o['conf'])
    return {'ok': True, 'objects': objs[:20]}


def run_pose(path, conf_thres=0.4):
    mp = MODELS['pose']
    if not os.path.exists(mp):
        return {'ok': False, 'error': '模型不存在: ' + mp}
    got = load_img(path, 640)
    if got is None:
        return {'ok': False, 'error': '读不了图片'}
    canvas, scale, left, top, ow, oh = got

    blob = canvas[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
    blob = np.expand_dims(blob, 0)

    sess = ort.InferenceSession(mp, providers=['CPUExecutionProvider'])
    out = sess.run(None, {sess.get_inputs()[0].name: blob})[0]  # (1,56,N)

    pred = out[0].T  # (N,56): 4 box + 1 conf + 17*3 kpt
    conf = pred[:, 4]
    keep_idx = np.where(conf > conf_thres)[0]

    result = {'ok': True, 'persons': 0, 'boxes': []}
    if len(keep_idx):
        cx, cy, bw, bh = pred[keep_idx, 0], pred[keep_idx, 1], pred[keep_idx, 2], pred[keep_idx, 3]
        x1 = (cx - bw / 2 - left) / scale
        y1 = (cy - bh / 2 - top) / scale
        x2 = (cx + bw / 2 - left) / scale
        y2 = (cy + bh / 2 - top) / scale
        boxes = np.stack([x1, y1, x2, y2], 1)
        scores = conf[keep_idx]

        # 一个人可能检出多个框，做 NMS
        sel = nms(boxes, scores)
        result['persons'] = len(sel)
        for k in sel:
            result['boxes'].append([
                round(float(max(0, boxes[k][0]))), round(float(max(0, boxes[k][1]))),
                round(float(min(ow, boxes[k][2]))), round(float(min(oh, boxes[k][3]))),
            ])
    return result


def run_cls(path):
    mp = MODELS['cls']
    if not os.path.exists(mp):
        return {'ok': False, 'error': '模型不存在: ' + mp}
    got = load_img(path, 224)
    if got is None:
        return {'ok': False, 'error': '读不了图片'}
    img = got[0]   # 已经是 letterbox 过的 224x224 BGR

    blob = img[:, :, ::-1].transpose(2, 0, 1).astype(np.float32) / 255.0
    blob = np.expand_dims(blob, 0)

    sess = ort.InferenceSession(mp, providers=['CPUExecutionProvider'])
    out = sess.run(None, {sess.get_inputs()[0].name: blob})[0][0]

    e = np.exp(out - out.max())
    probs = e / e.sum()
    top5 = np.argsort(-probs)[:5]
    return {
        'ok': True,
        'top5': [{'id': int(i), 'prob': round(float(probs[i]), 4)} for i in top5],
    }


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'error': '用法: yolo.py <detect|pose|cls|all> <图片>'},
                         ensure_ascii=False))
        return
    mode = sys.argv[1]
    path = sys.argv[2]

    if not os.path.exists(path):
        print(json.dumps({'ok': False, 'error': '图片不存在: ' + path}, ensure_ascii=False))
        return

    import time
    t0 = time.time()
    try:
        if mode == 'detect':
            r = run_detect(path)
        elif mode == 'pose':
            r = run_pose(path)
        elif mode == 'cls':
            r = run_cls(path)
        elif mode == 'all':
            r = {'ok': True, 'detect': run_detect(path), 'pose': run_pose(path), 'cls': run_cls(path)}
        else:
            r = {'ok': False, 'error': '未知模式: ' + mode}
    except Exception as e:
        r = {'ok': False, 'error': type(e).__name__ + ': ' + str(e)[:200]}

    r['ms'] = int((time.time() - t0) * 1000)
    print(json.dumps(r, ensure_ascii=False))


if __name__ == '__main__':
    main()