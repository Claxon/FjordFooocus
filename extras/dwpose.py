# DWPose: Skeletal pose detection using ONNX
# Two-stage pipeline: YOLOX person detection -> DWPose keypoint estimation -> skeleton drawing
# Follows extras/wd14tagger.py pattern: global model cache, lazy loading, ort.InferenceSession

import numpy as np
import cv2
import os

# Global model cache (lazy loaded on first use)
_yolox_session = None
_dwpose_session = None
_dwpose_input_size = None  # (W, H) read from the model


def _load_models():
    """Load ONNX models lazily, caching globally."""
    global _yolox_session, _dwpose_session, _dwpose_input_size

    if _yolox_session is None:
        import onnxruntime as ort
        import modules.config

        yolox_path, dwpose_path = modules.config.downloading_dwpose_detector()

        providers = ort.get_available_providers()
        # Prefer CPU for pose detection to avoid competing with diffusion model for GPU VRAM
        cpu_providers = [p for p in providers if 'CPU' in p]
        if cpu_providers:
            providers = cpu_providers

        _yolox_session = ort.InferenceSession(yolox_path, providers=providers)
        _dwpose_session = ort.InferenceSession(dwpose_path, providers=providers)

        # Read actual model input shape: NCHW -> (W, H)
        dw_input = _dwpose_session.get_inputs()[0]
        dw_shape = dw_input.shape  # e.g. [1, 3, 384, 288]
        _dwpose_input_size = (int(dw_shape[3]), int(dw_shape[2]))  # (W=288, H=384)

        print(f'[DWPose] Loaded models with providers: {providers}')
        print(f'[DWPose] Pose model input: {dw_shape} -> (W={_dwpose_input_size[0]}, H={_dwpose_input_size[1]})')

    return _yolox_session, _dwpose_session


# ======== YOLOX Person Detection ========

def _yolox_preprocess(img, input_size=(640, 640)):
    """Letterbox resize and normalize for YOLOX.

    Args:
        img: BGR uint8 numpy array (H, W, 3)
        input_size: (height, width) tuple

    Returns:
        (padded_img, ratio) where padded_img is NCHW float32
    """
    h, w = img.shape[:2]
    ratio = min(input_size[0] / h, input_size[1] / w)
    new_h, new_w = int(h * ratio), int(w * ratio)

    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    # Pad with gray (114) to target size
    padded = np.full((input_size[0], input_size[1], 3), 114, dtype=np.uint8)
    padded[:new_h, :new_w, :] = resized

    padded = padded.astype(np.float32)
    padded = padded.transpose(2, 0, 1)      # HWC -> CHW
    padded = np.expand_dims(padded, axis=0)  # -> NCHW

    return padded, ratio


def _nms(boxes, scores, nms_threshold=0.45):
    """Non-maximum suppression via OpenCV."""
    if len(scores) == 0:
        return np.array([], dtype=np.int32)

    # cv2.dnn.NMSBoxes expects [x, y, w, h] format
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    widths = x2 - x1
    heights = y2 - y1

    bboxes_for_nms = np.stack([x1, y1, widths, heights], axis=1).tolist()
    scores_list = scores.tolist()

    indices = cv2.dnn.NMSBoxes(bboxes_for_nms, scores_list, 0.0, nms_threshold)
    if len(indices) == 0:
        return np.array([], dtype=np.int32)

    return np.array(indices).flatten()


def _yolox_postprocess(output, ratio, score_threshold=0.3, nms_threshold=0.45):
    """Decode YOLOX output to person bounding boxes.

    Handles both formats:
      - Raw: [N, 85] (4 box + 1 obj + 80 classes) with grid-based encoding
      - Decoded: [N, 5] or [N, 6] (x1, y1, x2, y2, score[, class]) already in pixel coords

    Returns:
        numpy array of shape [M, 5] = [x1, y1, x2, y2, score] in original image coords
    """
    predictions = output

    if predictions.shape[0] == 0:
        return np.empty((0, 5), dtype=np.float32)

    num_cols = predictions.shape[1]
    print(f'[DWPose] YOLOX output shape: [{predictions.shape[0]}, {num_cols}]')

    if num_cols <= 6:
        # Already decoded format: [x1, y1, x2, y2, score] or [x1, y1, x2, y2, score, class]
        x1 = predictions[:, 0] / ratio
        y1 = predictions[:, 1] / ratio
        x2 = predictions[:, 2] / ratio
        y2 = predictions[:, 3] / ratio
        person_scores = predictions[:, 4]

        mask = person_scores > score_threshold
        if not np.any(mask):
            return np.empty((0, 5), dtype=np.float32)

        boxes = np.stack([x1[mask], y1[mask], x2[mask], y2[mask]], axis=1).astype(np.float32)
        person_scores = person_scores[mask].astype(np.float32)

        indices = _nms(boxes, person_scores, nms_threshold)
        if len(indices) == 0:
            return np.empty((0, 5), dtype=np.float32)
        return np.column_stack([boxes[indices], person_scores[indices]])

    # Raw format: [N, 85] with grid-based encoding
    # Build grids for anchor decoding: strides [8, 16, 32] on 640x640
    grids = []
    strides_expanded = []
    for stride in [8, 16, 32]:
        grid_h = 640 // stride
        grid_w = 640 // stride
        yv, xv = np.meshgrid(np.arange(grid_h), np.arange(grid_w), indexing='ij')
        grid = np.stack([xv, yv], axis=2).reshape(-1, 2).astype(np.float32)
        grids.append(grid)
        strides_expanded.append(np.full((grid_h * grid_w, 1), stride, dtype=np.float32))

    grids = np.concatenate(grids, axis=0)               # [8400, 2]
    strides = np.concatenate(strides_expanded, axis=0)   # [8400, 1]

    num_proposals = grids.shape[0]
    if predictions.shape[0] == num_proposals:
        # Grid-based decode
        boxes_xy = (predictions[:, :2] + grids) * strides
        boxes_wh = np.exp(np.clip(predictions[:, 2:4], -10, 10)) * strides
    else:
        # Unknown proposal count — treat as center-format without grid
        boxes_xy = predictions[:, :2]
        boxes_wh = predictions[:, 2:4]

    # Center format -> corner format
    x1 = (boxes_xy[:, 0] - boxes_wh[:, 0] / 2) / ratio
    y1 = (boxes_xy[:, 1] - boxes_wh[:, 1] / 2) / ratio
    x2 = (boxes_xy[:, 0] + boxes_wh[:, 0] / 2) / ratio
    y2 = (boxes_xy[:, 1] + boxes_wh[:, 1] / 2) / ratio

    # Score = objectness * class_score (person = class 0)
    objectness = predictions[:, 4]
    class_scores = predictions[:, 5:]
    person_scores = objectness * class_scores[:, 0]

    mask = person_scores > score_threshold
    if not np.any(mask):
        return np.empty((0, 5), dtype=np.float32)

    boxes = np.stack([x1[mask], y1[mask], x2[mask], y2[mask]], axis=1).astype(np.float32)
    person_scores = person_scores[mask].astype(np.float32)

    indices = _nms(boxes, person_scores, nms_threshold)
    if len(indices) == 0:
        return np.empty((0, 5), dtype=np.float32)

    return np.column_stack([boxes[indices], person_scores[indices]])


# ======== DWPose Keypoint Estimation ========

# ImageNet normalization constants (RGB order)
_MEAN = np.array([123.675, 116.28, 103.53], dtype=np.float32)
_STD = np.array([58.395, 57.12, 57.375], dtype=np.float32)


def _get_affine_transform(center, scale, output_size, inv=False):
    """Compute affine transform between original image crop and model input.

    Args:
        center: [cx, cy] center of the crop in original image
        scale: [w, h] size of the crop region (matching model aspect ratio)
        output_size: [model_w, model_h]
        inv: if True, return inverse transform (model -> original)

    Returns:
        2x3 affine transform matrix
    """
    src_w, src_h = scale[0], scale[1]
    dst_w, dst_h = output_size[0], output_size[1]

    src = np.array([
        [center[0], center[1]],                          # center
        [center[0], center[1] - src_h * 0.5],            # center-top
        [center[0] - src_w * 0.5, center[1]],            # center-left
    ], dtype=np.float32)

    dst = np.array([
        [dst_w * 0.5, dst_h * 0.5],                      # center
        [dst_w * 0.5, 0],                                 # center-top
        [0, dst_h * 0.5],                                 # center-left
    ], dtype=np.float32)

    if inv:
        trans = cv2.getAffineTransform(dst, src)
    else:
        trans = cv2.getAffineTransform(src, dst)

    return trans


def _dwpose_preprocess(img, bbox, input_size):
    """Crop person region using affine transform and prepare for DWPose.

    The crop matches the model's aspect ratio to avoid distortion, and uses
    an affine transform so coordinate mapping back is exact.

    Args:
        img: RGB uint8 numpy array (H, W, 3)
        bbox: [x1, y1, x2, y2, score]
        input_size: (model_w, model_h) e.g. (288, 384)

    Returns:
        (input_tensor, meta) or (None, None) if crop is empty
    """
    x1, y1, x2, y2 = bbox[:4]
    h, w = img.shape[:2]

    # Compute center and size of detection
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    bw = max(x2 - x1, 1)
    bh = max(y2 - y1, 1)

    model_w, model_h = input_size
    aspect_ratio = model_w / model_h  # e.g. 0.75 for 288/384

    # Adjust bbox to match model aspect ratio
    if bw / bh > aspect_ratio:
        # bbox is wider than model expects -> expand height
        new_w = bw
        new_h = bw / aspect_ratio
    else:
        # bbox is taller -> expand width
        new_h = bh
        new_w = bh * aspect_ratio

    # Add 25% padding
    new_w *= 1.25
    new_h *= 1.25

    center = np.array([cx, cy], dtype=np.float32)
    scale = np.array([new_w, new_h], dtype=np.float32)

    # Compute affine transform and warp
    trans = _get_affine_transform(center, scale, (model_w, model_h))
    crop_resized = cv2.warpAffine(img, trans, (model_w, model_h), flags=cv2.INTER_LINEAR)

    if crop_resized.size == 0:
        return None, None

    # Normalize: keep RGB (model expects RGB), apply ImageNet mean/std
    inp = crop_resized.astype(np.float32)
    inp = (inp - _MEAN) / _STD
    inp = inp.transpose(2, 0, 1)      # HWC -> CHW
    inp = np.expand_dims(inp, axis=0)  # -> NCHW

    return inp, (center, scale, input_size)


def _dwpose_postprocess(simcc_x, simcc_y, center, scale, input_size):
    """Decode SimCC format outputs to keypoint coordinates.

    Uses inverse affine transform for exact coordinate mapping.

    Args:
        simcc_x: [1, K, Wx] probability distribution over x
        simcc_y: [1, K, Wy] probability distribution over y
        center: [2] center of the crop in original image
        scale: [2] (w, h) of the crop region (aspect-corrected)
        input_size: (model_w, model_h)

    Returns:
        (keypoints, confidences) where keypoints is [K, 2] in original image coords
    """
    num_keypoints = simcc_x.shape[1]

    # Decode: argmax gives the coordinate, max gives the confidence
    x_locs = np.argmax(simcc_x[0], axis=1).astype(np.float32)  # [K]
    y_locs = np.argmax(simcc_y[0], axis=1).astype(np.float32)  # [K]

    x_confs = np.max(simcc_x[0], axis=1)
    y_confs = np.max(simcc_y[0], axis=1)
    confidences = np.minimum(x_confs, y_confs)

    # SimCC uses a split ratio (typically 2x the input dimensions)
    model_w, model_h = input_size
    simcc_ratio_x = simcc_x.shape[2] / model_w
    simcc_ratio_y = simcc_y.shape[2] / model_h

    # Coordinates in model input space
    x_coords = x_locs / simcc_ratio_x  # [0, model_w]
    y_coords = y_locs / simcc_ratio_y  # [0, model_h]

    # Map back to original image via inverse affine transform
    inv_trans = _get_affine_transform(center, scale, (model_w, model_h), inv=True)

    keypoints = np.zeros((num_keypoints, 2), dtype=np.float32)
    for i in range(num_keypoints):
        pt = np.array([x_coords[i], y_coords[i], 1.0], dtype=np.float32)
        mapped = inv_trans @ pt  # 2x3 @ 3 = 2
        keypoints[i, 0] = mapped[0]
        keypoints[i, 1] = mapped[1]

    return keypoints, confidences


# ======== Skeleton Drawing ========

# COCO 17 body keypoint connections
_BODY_CONNECTIONS = [
    (0, 1), (0, 2),               # nose -> eyes
    (1, 3), (2, 4),               # eyes -> ears
    (5, 6),                        # shoulder -> shoulder
    (5, 7), (7, 9),               # left arm
    (6, 8), (8, 10),              # right arm
    (5, 11), (6, 12),             # torso
    (11, 12),                      # hip -> hip
    (11, 13), (13, 15),           # left leg
    (12, 14), (14, 16),           # right leg
]

# OpenPose-style color palette (RGB) for body connections
_BODY_LIMB_COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0),
    (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85),
    (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
    (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255),
    (255, 0, 170),
]

# Color palette for keypoint circles
_BODY_KP_COLORS = [
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0),
    (170, 255, 0), (85, 255, 0), (0, 255, 0), (0, 255, 85),
    (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
    (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255),
    (255, 0, 170),
]

# Hand connections (21 keypoints per hand)
# DWPose 133-point model: body 0-16, feet 17-22, face 23-90, left hand 91-111, right hand 112-132
_HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),           # thumb
    (0, 5), (5, 6), (6, 7), (7, 8),           # index
    (0, 9), (9, 10), (10, 11), (11, 12),      # middle
    (0, 13), (13, 14), (14, 15), (15, 16),    # ring
    (0, 17), (17, 18), (18, 19), (19, 20),    # pinky
]


def _draw_skeleton(canvas, keypoints, confidences, threshold=0.3):
    """Draw skeleton on canvas for one person.

    Args:
        canvas: HWC uint8 numpy array (will be drawn on in-place)
        keypoints: [K, 2] array of (x, y) coordinates
        confidences: [K] array of confidence scores
        threshold: minimum confidence to draw
    """
    h, w = canvas.shape[:2]
    num_kp = len(confidences)

    def _in_bounds(pt):
        return 0 <= pt[0] < w and 0 <= pt[1] < h

    # Draw body connections
    for idx, (i, j) in enumerate(_BODY_CONNECTIONS):
        if i < num_kp and j < num_kp:
            if confidences[i] > threshold and confidences[j] > threshold:
                pt1 = (int(round(keypoints[i, 0])), int(round(keypoints[i, 1])))
                pt2 = (int(round(keypoints[j, 0])), int(round(keypoints[j, 1])))
                if _in_bounds(pt1) or _in_bounds(pt2):
                    color = _BODY_LIMB_COLORS[idx % len(_BODY_LIMB_COLORS)]
                    cv2.line(canvas, pt1, pt2, color, thickness=2, lineType=cv2.LINE_AA)

    # Draw body keypoints
    for i in range(min(17, num_kp)):
        if confidences[i] > threshold:
            pt = (int(round(keypoints[i, 0])), int(round(keypoints[i, 1])))
            if _in_bounds(pt):
                color = _BODY_KP_COLORS[i % len(_BODY_KP_COLORS)]
                cv2.circle(canvas, pt, 4, color, -1, lineType=cv2.LINE_AA)

    # Draw hands if available (keypoints 91-132 in 133-point model)
    for hand_offset, hand_color in [(91, (0, 255, 0)), (112, (0, 0, 255))]:
        for (i, j) in _HAND_CONNECTIONS:
            ki, kj = hand_offset + i, hand_offset + j
            if ki < num_kp and kj < num_kp:
                if confidences[ki] > threshold and confidences[kj] > threshold:
                    pt1 = (int(round(keypoints[ki, 0])), int(round(keypoints[ki, 1])))
                    pt2 = (int(round(keypoints[kj, 0])), int(round(keypoints[kj, 1])))
                    if _in_bounds(pt1) or _in_bounds(pt2):
                        cv2.line(canvas, pt1, pt2, hand_color, thickness=1, lineType=cv2.LINE_AA)

        for i in range(21):
            ki = hand_offset + i
            if ki < num_kp and confidences[ki] > threshold:
                pt = (int(round(keypoints[ki, 0])), int(round(keypoints[ki, 1])))
                if _in_bounds(pt):
                    cv2.circle(canvas, pt, 2, hand_color, -1, lineType=cv2.LINE_AA)


# ======== Main Entry Point ========

def detect_and_draw(image_rgb):
    """Full DWPose pipeline: detect persons, estimate poses, draw skeleton.

    Args:
        image_rgb: numpy array, HWC, uint8, RGB format

    Returns:
        numpy array, HWC, uint8, RGB - skeleton on black background
    """
    assert isinstance(image_rgb, np.ndarray)
    assert image_rgb.ndim == 3

    h, w = image_rgb.shape[:2]

    yolox_session, dwpose_session = _load_models()
    input_size = _dwpose_input_size  # (W, H) read from model

    # Step 1: Detect persons with YOLOX (expects BGR)
    img_bgr = image_rgb[:, :, ::-1].copy()
    yolox_input, ratio = _yolox_preprocess(img_bgr)

    input_name = yolox_session.get_inputs()[0].name
    yolox_out = yolox_session.run(None, {input_name: yolox_input})
    raw_output = yolox_out[0]

    # Handle output shape: [1, N, K] or [N, K]
    if raw_output.ndim == 3:
        raw_output = raw_output[0]

    bboxes = _yolox_postprocess(raw_output, ratio)

    if len(bboxes) == 0:
        print('[DWPose] No persons detected')
        return np.zeros((h, w, 3), dtype=np.uint8)

    print(f'[DWPose] Detected {len(bboxes)} person(s), bbox[0]={bboxes[0][:4].astype(int).tolist()}')

    # Step 2: Estimate pose for each person
    canvas = np.zeros((h, w, 3), dtype=np.uint8)

    dwpose_input_name = dwpose_session.get_inputs()[0].name

    for bbox in bboxes:
        inp, meta = _dwpose_preprocess(image_rgb, bbox, input_size)
        if inp is None:
            continue

        center, scale, model_size = meta

        outputs = dwpose_session.run(None, {dwpose_input_name: inp})

        # DWPose outputs SimCC: two tensors for x and y coordinates
        if len(outputs) < 2:
            print('[DWPose] Unexpected model output format')
            continue

        out_a, out_b = outputs[0], outputs[1]

        # Determine which output is simcc_x (width-related) and simcc_y (height-related)
        # simcc_x last dim should be proportional to model width
        # simcc_y last dim should be proportional to model height
        model_w, model_h = model_size
        if out_a.shape[-1] < out_b.shape[-1]:
            # out_a is smaller -> proportional to width (smaller dim)
            simcc_x, simcc_y = out_a, out_b
        elif out_a.shape[-1] > out_b.shape[-1]:
            # out_a is larger -> proportional to height
            simcc_x, simcc_y = out_b, out_a
        else:
            # Same size — default ordering
            simcc_x, simcc_y = out_a, out_b

        keypoints, confidences = _dwpose_postprocess(
            simcc_x, simcc_y, center, scale, model_size
        )

        _draw_skeleton(canvas, keypoints, confidences)

    return canvas
