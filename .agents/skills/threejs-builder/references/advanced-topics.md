# Advanced Three.js Topics

Progressive disclosure reference for topics beyond simple scenes.

**Related guides:**
- [`gltf-loading-guide.md`](gltf-loading-guide.md) - Loading, caching, and cloning 3D models
- [`game-patterns.md`](game-patterns.md) - Game loops, screen effects, animation states, parallax

---

## Loading 3D Models (GLTF/GLB)

**→ See dedicated guide: [`gltf-loading-guide.md`](gltf-loading-guide.md)**

For comprehensive GLTF loading patterns including basic loading, promise-based approaches, fallbacks, batch loading, caching, and troubleshooting, refer to the dedicated GLTF loading guide.

Quick example using import maps:

```html
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

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const loader = new GLTFLoader();
    loader.load(
        'path/to/model.glb',
        (gltf) => {
            gltf.scene.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });
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

    renderer.setAnimationLoop(() => {
        renderer.render(scene, camera);
    });
</script>
```

**Key improvement: Import maps** resolve Three.js module paths correctly, avoiding long unpkg URLs.

---

## Post-Processing (Bloom, Depth of Field)

For visual effects like bloom, use the EffectComposer:

```html
<script type="module">
    import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
    import { EffectComposer } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js';
    import { RenderPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/RenderPass.js';
    import { UnrealBloomPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js';

    // Basic setup...
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ReinhardToneMapping;

    // Post-processing
    const renderScene = new RenderPass(scene, camera);

    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        1.5,  // strength
        0.4,  // radius
        0.85  // threshold
    );

    const composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);

    renderer.setAnimationLoop(() => {
        composer.render();
    });
</script>
```

---

## Custom Shaders (ShaderMaterial)

For custom visual effects, write GLSL shaders:

```javascript
const vertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const fragmentShader = `
    varying vec2 vUv;
    uniform float time;
    void main() {
        vec3 color = vec3(
            0.5 + 0.5 * sin(time + vUv.x * 10.0),
            0.5 + 0.5 * sin(time + vUv.y * 10.0),
            0.5 + 0.5 * sin(time)
        );
        gl_FragColor = vec4(color, 1.0);
    }
`;

const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
        time: { value: 0 }
    }
});

// In animation loop:
material.uniforms.time.value = time * 0.001;
```

---

## Text and Sprites

For text, use sprites or canvas textures:

```javascript
function createTextSprite(text) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 128;

    context.fillStyle = 'rgba(0, 0, 0, 0.5)';
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = 'white';
    context.font = '24px Arial';
    context.textAlign = 'center';
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2, 1, 1);
    return sprite;
}

const label = createTextSprite('Hello!');
label.position.set(0, 2, 0);
scene.add(label);
```

---

## Raycasting (Mouse Picking)

Raycasting allows selecting objects with mouse/touch:

```javascript
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function onPointerMove(event) {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function onClick() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(scene.children, true);
    if (intersects.length > 0) {
        console.log('Hit:', intersects[0].object);
    }
}

window.addEventListener('pointermove', onPointerMove);
window.addEventListener('click', onClick);
```

---

## Environment Maps (Reflections)

For realistic reflections, use an environment map:

```javascript
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

new RGBELoader().load('hdr/studio.hdr', (texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = texture;
    scene.background = texture; // optional
});
```

---

## InstancedMesh (Many Similar Objects)

For lots of repeated objects (e.g., particles, trees), use instancing:

```javascript
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshStandardMaterial({ color: 0x44aa88 });
const count = 1000;

const mesh = new THREE.InstancedMesh(geometry, material, count);
const dummy = new THREE.Object3D();

for (let i = 0; i < count; i++) {
    dummy.position.set(
        (Math.random() - 0.5) * 50,
        (Math.random() - 0.5) * 50,
        (Math.random() - 0.5) * 50
    );
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
}

scene.add(mesh);
```

---

## Physics Integration (Cannon.js)

Three.js doesn't include physics. Use a library like Cannon.js for rigid body simulation:

```javascript
// Pseudo-code
// const world = new CANNON.World();
// const body = new CANNON.Body({ mass: 1, shape: new CANNON.Box(...) });
// world.addBody(body);
//
// In animation loop:
// world.step(1/60);
// mesh.position.copy(body.position);
// mesh.quaternion.copy(body.quaternion);
```

---

## Installation with npm

For real projects, install Three.js:

```bash
npm install three
```

Then import:

```javascript
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
```

---

## TypeScript Support

Three.js ships with TypeScript types.

Tips:
- Use `as const` for config objects
- Use `THREE.Mesh<THREE.BufferGeometry, THREE.Material>` when types get complex
- Prefer explicit types for vectors and colors

---

## Key Module Import Paths (r160+)

Depending on environment:

**Bundler/npm**:
- `three` - core
- `three/addons/...` - examples modules (controls, loaders, postprocessing)

**CDN/unpkg**:
- `https://unpkg.com/three@0.160.0/build/three.module.js`
- `https://unpkg.com/three@0.160.0/examples/jsm/...`

---

## Performance Tips

Keep scenes fast:
- Cap pixel ratio: `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`
- Minimize draw calls: merge geometry, use instancing
- Avoid huge texture sizes
- Prefer fewer lights; bake where possible
- Use `MeshStandardMaterial` sparingly with many objects
- Use `frustumCulled` wisely for custom objects

---

## Debug Helpers

Useful helpers:

```javascript
scene.add(new THREE.AxesHelper(5));
scene.add(new THREE.GridHelper(10, 10));

const box = new THREE.BoxHelper(mesh, 0xffff00);
scene.add(box);
```

