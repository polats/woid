// SMPL-X retargeting tables — vendored from kimodo/web/src/rigs.js.
// We only carry the bits needed to drive the male_stylized_skinned model
// from kimodo motion JSON (the skinned rig uses an identity SMPL-X mapping,
// so the elaborate Mixamo / blender-studio configs aren't needed here).
//
// If you ever sync these with kimodo, the canonical source is upstream;
// this is a snapshot.

// SMPL-X rest world joint positions (from J_regressor @ v_template).
export const SMPLX_REST_WORLD = {
  pelvis:         [ 0.0031, -0.3514,  0.0120],
  left_hip:       [ 0.0613, -0.4442, -0.0140],
  right_hip:      [-0.0601, -0.4553, -0.0092],
  spine1:         [ 0.0004, -0.2415, -0.0156],
  left_knee:      [ 0.1160, -0.8229, -0.0234],
  right_knee:    [-0.1044, -0.8177, -0.0260],
  spine2:         [ 0.0098, -0.1097, -0.0215],
  left_ankle:     [ 0.0726, -1.2260, -0.0552],
  right_ankle:   [-0.0889, -1.2284, -0.0462],
  spine3:         [-0.0015, -0.0574,  0.0069],
  left_foot:      [ 0.1198, -1.2840,  0.0630],
  right_foot:    [-0.1277, -1.2868,  0.0728],
  neck:           [-0.0137,  0.1077, -0.0247],
  left_collar:    [ 0.0448,  0.0275, -0.0003],
  right_collar:  [-0.0492,  0.0269, -0.0065],
  head:           [ 0.0111,  0.2682, -0.0040],
  left_shoulder:  [ 0.1641,  0.0852, -0.0158],
  right_shoulder:[-0.1518,  0.0804, -0.0191],
  left_elbow:     [ 0.4182,  0.0131, -0.0582],
  right_elbow:   [-0.4229,  0.0439, -0.0456],
  left_wrist:     [ 0.6702,  0.0363, -0.0607],
  right_wrist:   [-0.6722,  0.0394, -0.0609],
}

export const KIMODO_PARENT = {
  pelvis: null,
  left_hip: 'pelvis', right_hip: 'pelvis',
  spine1: 'pelvis',
  left_knee: 'left_hip', right_knee: 'right_hip',
  spine2: 'spine1',
  left_ankle: 'left_knee', right_ankle: 'right_knee',
  spine3: 'spine2',
  left_foot: 'left_ankle', right_foot: 'right_ankle',
  neck: 'spine3',
  left_collar: 'spine3', right_collar: 'spine3',
  head: 'neck',
  left_shoulder: 'left_collar', right_shoulder: 'right_collar',
  left_elbow: 'left_shoulder', right_elbow: 'right_shoulder',
  left_wrist: 'left_elbow', right_wrist: 'right_elbow',
}

export const KIMODO_CHILD = {
  pelvis: 'spine1',
  left_hip: 'left_knee', right_hip: 'right_knee',
  spine1: 'spine2',
  left_knee: 'left_ankle', right_knee: 'right_ankle',
  spine2: 'spine3',
  left_ankle: 'left_foot', right_ankle: 'right_foot',
  spine3: 'neck',
  left_foot: null, right_foot: null,
  neck: 'head',
  left_collar: 'left_shoulder', right_collar: 'right_shoulder',
  head: null,
  left_shoulder: 'left_elbow', right_shoulder: 'right_elbow',
  left_elbow: 'left_wrist', right_elbow: 'right_wrist',
  left_wrist: null, right_wrist: null,
}

export const KIMODO_TWIST_REF = {
  pelvis: 'left_hip',
  spine1: 'left_collar',
  spine2: 'left_collar',
  spine3: 'left_collar',
  neck:   'left_collar',
  left_collar:    'spine2',
  right_collar:   'spine2',
  left_shoulder:  'spine2',
  right_shoulder: 'spine2',
  left_elbow:     'spine2',
  right_elbow:    'spine2',
  left_hip:   'left_collar',
  right_hip:  'right_collar',
  left_knee:  'left_collar',
  right_knee: 'right_collar',
  left_ankle: 'left_collar',
  right_ankle:'right_collar',
}

export function identityMapping() {
  const names = [
    'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee',
    'spine2', 'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot',
    'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
    'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  ]
  return Object.fromEntries(names.map((n) => [n, n]))
}

// Mixamo bone mapping — used to drive Mixamo-rigged avatars (e.g. our
// /avatar_animated.glb on the Stage) from kimodo SMPL-X motion.
export function mixamoMapping() {
  return {
    pelvis:          'mixamorig:Hips',
    left_hip:        'mixamorig:LeftUpLeg',
    right_hip:       'mixamorig:RightUpLeg',
    spine1:          'mixamorig:Spine',
    left_knee:       'mixamorig:LeftLeg',
    right_knee:      'mixamorig:RightLeg',
    spine2:          'mixamorig:Spine1',
    left_ankle:      'mixamorig:LeftFoot',
    right_ankle:     'mixamorig:RightFoot',
    spine3:          'mixamorig:Spine2',
    left_foot:       'mixamorig:LeftToeBase',
    right_foot:      'mixamorig:RightToeBase',
    neck:            'mixamorig:Neck',
    left_collar:     'mixamorig:LeftShoulder',
    right_collar:    'mixamorig:RightShoulder',
    head:            'mixamorig:Head',
    left_shoulder:   'mixamorig:LeftArm',
    right_shoulder:  'mixamorig:RightArm',
    left_elbow:      'mixamorig:LeftForeArm',
    right_elbow:     'mixamorig:RightForeArm',
    left_wrist:      'mixamorig:LeftHand',
    right_wrist:     'mixamorig:RightHand',
  }
}

// Character config for the preview canvas. Mirrors kimodo's `male_stylized_skinned`.
export const MALE_STYLIZED = {
  id: 'male_stylized_skinned',
  label: 'Male Stylized',
  url: '/models/male_stylized_skinned.glb',
  skinned: true,
  mapping: identityMapping(),
  scale: 1.0,
}
