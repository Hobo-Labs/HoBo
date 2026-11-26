# GLTF Loading Guide for Three.js

Modern patterns for loading, managing, and displaying 3D models in Three.js applications.

---

## Quick Start: The Minimal Pattern

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GLTF Loader</title>
    <style>
        * { margin: 0; padding: 0; }
        body { overflow: hidden; background: #000; }
        canvas { display: block; }
    </style>
</head>
<body>
    <script type="importmap">
    {
        "imports": {
            "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
            "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
        }
    }
    </script>

    <script type="module">
        import * as THREE from 'three';
        import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

        // Scene setup
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({ antialias: true });

        renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(renderer.domElement);

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(5, 10, 7);
        scene.add(directionalLight);

        // Load model
        const loader = new GLTFLoader();
        loader.load(
            'path/to/model.gltf',
            (gltf) => {
                console.log('Model loaded:', gltf);
                scene.add(gltf.scene);
                camera.position.z = 5;
            },
            (progress) => {
                console.log((progress.loaded / progress.total * 100).toFixed(0) + '%');
            },
            (error) => {
                console.error('Failed to load model:', error);
            }
        );

        // Animation loop
        renderer.setAnimationLoop(() => {
            renderer.render(scene, camera);
        });

        // Handle resize
        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });
    </script>
</body>
</html>
```

---

## Core Concepts

### Import Maps (Essential for ES Modules)

If you're using CDN modules, you need consistent import paths:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
  }
}
</script>
```

This lets you:
- `import * as THREE from 'three'`
- `import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'`

Without import maps, Three.js examples modules often fail due to inconsistent module resolution.

---

## Pattern 1: Basic Loading

```javascript
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
loader.load('model.glb', (gltf) => {
  scene.add(gltf.scene);
});
```

---

## Pattern 2: Promise-Based Loading

Wrap loading in a promise for cleaner async code:

```javascript
function loadGLTF(url) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(url, resolve, undefined, reject);
  });
}

const gltf = await loadGLTF('/models/robot.glb');
scene.add(gltf.scene);
```

---

## Pattern 3: Loading with Fallbacks

Provide fallback content while models load:

```javascript
const placeholder = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x444444 })
);
scene.add(placeholder);

loader.load('model.glb', (gltf) => {
  scene.remove(placeholder);
  scene.add(gltf.scene);
});
```

---

## Pattern 4: Batch Loading Multiple Models

Load multiple models in parallel:

```javascript
async function loadModels(urls) {
  const loader = new GLTFLoader();
  const tasks = urls.map(url => new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  }));
  return Promise.all(tasks);
}

const [ship, asteroid] = await loadModels([
  '/models/ship.glb',
  '/models/asteroid.glb'
]);

scene.add(ship.scene);
scene.add(asteroid.scene);
```

---

## Pattern 5: Caching & Reuse (with Animation Support)

Cache loaded models so you can clone them:

```javascript
const cache = new Map();

async function loadCached(url) {
  if (cache.has(url)) return cache.get(url);
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
  cache.set(url, gltf);
  return gltf;
}

const source = await loadCached('/models/character.glb');

// Clone scene graph
const clone = source.scene.clone(true);
scene.add(clone);

// For animations, use SkeletonUtils (advanced)
```

---

## Pattern 6: Model Normalization

Normalize scale/position/rotation so models fit consistently:

```javascript
function normalizeModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);

  const center = new THREE.Vector3();
  box.getCenter(center);
  root.position.sub(center); // center model at origin

  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = 1 / maxDim;
  root.scale.setScalar(scale);
}

loader.load('/models/thing.glb', (gltf) => {
  normalizeModel(gltf.scene);
  scene.add(gltf.scene);
});
```

---

## Common Pitfalls & Solutions

### ❌ GLTF Won't Load - File Not Found

Symptoms:
- Network error in console
- 404 for .gltf/.glb files

Fix:
- Ensure you're serving via a local web server (not `file://`)

```bash
# Start local server in your project directory
python -m http.server 8080

# Visit http://localhost:8080
```

---

### ❌ Models Look Wrong - Incorrect Scale/Rotation

Symptoms:
- Model is tiny/huge
- Model is rotated sideways

Fix:
- Normalize model scale/position
- Rotate around X axis if needed:

```javascript
gltf.scene.rotation.x = -Math.PI / 2; // common for Z-up models
```

---

### ❌ Animated Model Floats Above Ground

Cause: Root bone offset

Fix:
- Add a parent group to adjust position:

```javascript
const container = new THREE.Group();
container.add(gltf.scene);
container.position.y = -0.5;
scene.add(container);
```

---

### ❌ Cloned Animated Model Stays at Origin

Cause: Skeleton cloning needs special handling

Fix:
- Use `SkeletonUtils.clone`:

```javascript
import { SkeletonUtils } from 'three/addons/utils/SkeletonUtils.js';

const clonedScene = SkeletonUtils.clone(source.scene);
scene.add(clonedScene);
```

---

### ❌ No Shadows on GLTF Models

Fix: Enable shadows on renderer, lights, and meshes:

```javascript
renderer.shadowMap.enabled = true;
light.castShadow = true;

gltf.scene.traverse((child) => {
  if (child.isMesh) {
    child.castShadow = true;
    child.receiveShadow = true;
  }
});
```

---

### ❌ Slow Loading - Large Models Block Scene

Fixes:
- Use Draco compression (below)
- Load asynchronously and show placeholders
- Reduce polygon count and texture sizes

---

## Advanced: Draco Compression

Draco compresses mesh geometry for smaller downloads.

```javascript
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);
```

---

## Best Practices Summary

- Use import maps when using CDN
- Normalize scale/center models for consistency
- Cache GLTF results and clone
- Use `SkeletonUtils.clone` for animated rigs
- Add placeholders and progress feedback
- Optimize models (polycount, textures)

---

## Reference: GLTFLoader Callback Signature

```javascript
loader.load(
  url,
  function onLoad(gltf) {},
  function onProgress(event) {},
  function onError(error) {}
);
```

