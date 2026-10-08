import * as THREE from "three";
import { InputController } from "./InputController";
import type { RunnerHud } from "./types";
import { getActiveSkinId, getActiveEnvId, addWalletCoins, SKINS_CATALOG } from "./shopStorage";
import coinAudioUrl from "../assets/audio/coin.mp3";
import shieldAudioUrl from "../assets/audio/shield.mp3";
import magnetAudioUrl from "../assets/audio/magnet.mp3";
import destroyAudioUrl from "../assets/audio/destroy.mp3";
import failAudioUrl from "../assets/audio/fail.mp3";

const coinAudio = new Audio(coinAudioUrl);
const shieldAudio = new Audio(shieldAudioUrl);
const magnetAudio = new Audio(magnetAudioUrl);
const destroyAudio = new Audio(destroyAudioUrl);
const failAudio = new Audio(failAudioUrl);

type LaneIndex = 0 | 1 | 2;

type ObstacleKind = "low" | "overhead";

type PickupKind = "coin" | "magnet" | "shield";

type TrainKind = "flat" | "ramp";

interface TrainActor {
  kind: TrainKind;
  root: THREE.Group;
  box: THREE.Box3;
  roofPickups: PickupActor[];
  isMoving?: boolean;
}

interface ObstacleActor {
  kind: ObstacleKind;
  mesh: THREE.Object3D;
  box: THREE.Box3;
  size: THREE.Vector3;
}

interface PickupActor {
  kind: PickupKind;
  mesh: THREE.Object3D;
  independent: boolean;
}

interface CoinParticle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
}

interface CoinEffect {
  group: THREE.Group;
  particles: CoinParticle[];
  age: number;
  maxAge: number;
}

type HudListener = (hud: RunnerHud) => void;

/*
 * -------------------------------------------------------
 * КОНФИГУРАЦИЯ
 * -------------------------------------------------------
 */

const LANE_X = [-2.4, 0, 2.4] as const;

const PLAYER_WIDTH = 0.85;
const PLAYER_DEPTH = 0.75;

const PLAYER_STANDING_HEIGHT = 1.8;
const PLAYER_SLIDING_HEIGHT = 0.72;

const LANE_CHANGE_SPEED = 14;

const JUMP_VELOCITY = 15.5;
const FAST_FALL_VELOCITY = -24;
const GRAVITY = -44;

const SLIDE_DURATION = 0.75;

const WORLD_SPEED = 13;

const TRACK_TILE_LENGTH = 10;
const TRACK_TILE_COUNT = 18;

const TRAIN_WIDTH = 1.8;
const TRAIN_HEIGHT = 1.55;
const TRAIN_LENGTH = 8;

const RAMP_LENGTH = 3.6;

const RAMP_THICKNESS = 0.14;

const MAX_GROUNDED_STEP_UP = 0.55;

const MAX_GROUNDED_STEP_DOWN = 0.55;

const SURFACE_TOLERANCE = 0.12;

const RECYCLE_Z = 16;

/*
 * Плавное приближение значения к цели.
 *
 * В отличие от обычного lerp с фиксированным коэффициентом,
 * эта версия почти не зависит от частоты кадров.
 */
function damp(
  current: number,
  target: number,
  speed: number,
  delta: number,
): number {
  const factor = 1 - Math.exp(-speed * delta);

  return THREE.MathUtils.lerp(current, target, factor);
}

function shuffle<T>(items: T[]): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = THREE.MathUtils.randInt(0, index);

    const temporary = items[index];

    items[index] = items[randomIndex];
    items[randomIndex] = temporary;
  }
}

function randomLane(): LaneIndex {
  return THREE.MathUtils.randInt(0, 2) as LaneIndex;
}

/*
 * -------------------------------------------------------
 * ИГРА
 * -------------------------------------------------------
 */

export class RunnerGame {
  private readonly scene = new THREE.Scene();

  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 250);

  private readonly renderer: THREE.WebGLRenderer;

  private readonly clock = new THREE.Clock();

  private readonly input = new InputController();

  private readonly resizeObserver: ResizeObserver;

  private readonly playerGroup = new THREE.Group();

  private readonly playerMesh: THREE.Mesh;

  private humanoidGroup!: THREE.Group;
  private leftArmGroup!: THREE.Group;
  private rightArmGroup!: THREE.Group;
  private leftLegGroup!: THREE.Group;
  private rightLegGroup!: THREE.Group;

  private shieldAuraMesh!: THREE.Mesh;

  private readonly playerBox = new THREE.Box3();

  private readonly cameraTarget = new THREE.Vector3();

  private readonly temporaryWorldPosition = new THREE.Vector3();

  private readonly trackTiles: THREE.Group[] = [];

  private readonly trains: TrainActor[] = [];

  private readonly obstacles: ObstacleActor[] = [];

  private readonly pickups: PickupActor[] = [];

  private readonly coinEffects: CoinEffect[] = [];

  private hoodieMat!: THREE.MeshStandardMaterial;
  private pantsMat!: THREE.MeshStandardMaterial;
  private visorMat!: THREE.MeshStandardMaterial;
  private backpackMat!: THREE.MeshStandardMaterial;

  public updatePlayerSkin(): void {
    const skinId = getActiveSkinId();
    const skin = SKINS_CATALOG.find((s) => s.id === skinId) || SKINS_CATALOG[0];

    if (this.hoodieMat) {
      this.hoodieMat.color.set(skin.hoodieColor);
    }
    if (this.pantsMat) {
      this.pantsMat.color.set(skin.pantsColor);
    }
    if (this.visorMat) {
      this.visorMat.color.set(skin.visorColor);
      this.visorMat.emissive.set(skin.visorColor);
    }
    if (this.backpackMat) {
      this.backpackMat.color.set(skin.backpackColor);
    }
  }

  public getCurrentWorldSpeed(): number {
    return WORLD_SPEED + Math.min(12.0, (this.distance / 450) * 1.5);
  }

  private isGameActive = false;
  private isSfxMuted = false;

  public setSfxMuted(muted: boolean): void {
    this.isSfxMuted = muted;
  }

  private playSound(audio: HTMLAudioElement): void {
    if (this.isSfxMuted) return;
    try {
      const clone = audio.cloneNode() as HTMLAudioElement;
      clone.volume = 0.65;
      clone.play().catch(() => {
        // Browser autoplay policy fallback
      });
    } catch (err) {
      // Fallback
    }
  }

  private snowGroup: THREE.Group | null = null;
  private snowflakes: Array<{ mesh: THREE.Mesh; speedY: number; driftX: number }> = [];
  private ghostMeshes: THREE.Mesh[] = [];

  public updateEnvironmentTheme(): void {
    this.ghostMeshes = [];

    for (let i = 0; i < this.trackTiles.length; i += 1) {
      const tile = this.trackTiles[i];
      for (let c = tile.children.length - 1; c >= 0; c -= 1) {
        const child = tile.children[c];
        if (child.userData.isScenery) {
          tile.remove(child);
        }
      }
      this.populateTileScenery(tile, i);
    }

    this.createSnowSystem();
  }

  private createSnowSystem(): void {
    if (this.snowGroup) {
      this.scene.remove(this.snowGroup);
      this.snowGroup = null;
    }

    if (getActiveEnvId() !== "newyear") return;

    this.snowGroup = new THREE.Group();
    const snowMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      emissive: "#ffffff",
      emissiveIntensity: 0.8,
      roughness: 0.2,
    });

    const flakeGeo = new THREE.DodecahedronGeometry(0.08, 0);
    this.snowflakes = [];

    for (let i = 0; i < 120; i += 1) {
      const flake = new THREE.Mesh(flakeGeo, snowMat);
      flake.position.set(
        (Math.random() - 0.5) * 36,
        Math.random() * 18,
        (Math.random() - 0.5) * 45 - 5,
      );
      this.snowGroup.add(flake);
      this.snowflakes.push({
        mesh: flake,
        speedY: 1.8 + Math.random() * 2.5,
        driftX: (Math.random() - 0.5) * 0.8,
      });
    }

    this.scene.add(this.snowGroup);
  }

  private updateSnowSystem(delta: number): void {
    if (!this.snowGroup || getActiveEnvId() !== "newyear") return;

    for (const flake of this.snowflakes) {
      flake.mesh.position.y -= flake.speedY * delta;
      flake.mesh.position.x += flake.driftX * delta;

      if (flake.mesh.position.y < 0) {
        flake.mesh.position.y = 18;
        flake.mesh.position.x = (Math.random() - 0.5) * 36;
      }
    }
  }

  private updateGhosts(): void {
    if (getActiveEnvId() !== "halloween" || this.ghostMeshes.length === 0) return;
    const time = this.clock.getElapsedTime();
    for (let i = 0; i < this.ghostMeshes.length; i += 1) {
      const ghost = this.ghostMeshes[i];
      const baseY = (ghost.userData.baseY as number | undefined) ?? 1.2;
      ghost.position.y = baseY + Math.sin(time * 2.5 + i) * 0.25;
    }
  }

  private currentLane: LaneIndex = 1;

  private playerX: number = LANE_X[1];

  private readonly container: HTMLDivElement;

  private readonly onHudChange: HudListener;

  /*
   * feetY — высота ног игрока над землёй.
   *
   * Это удобнее, чем хранить позицию центра модели:
   * feetY = 0 означает, что игрок стоит на земле.
   * feetY = 2 означает, что игрок стоит на крыше.
   */
  private playerFeetY = 0;

  private verticalVelocity = 0;

  private grounded = true;

  private sliding = false;

  private slideRemaining = 0;

  private distance = 0;

  private coins = 0;

  private shieldActive = false;

  private magnetRemaining = 0;

  private hitCooldown = 0;

  private gameOver = false;

  /*
   * Позиция, за которой будут появляться новые объекты.
   * Она движется вместе с игровым миром.
   */
  private spawnCursorZ = -12;

  private hudUpdateAccumulator = 0;

  private previousHudKey = "";

  constructor(
    container: HTMLDivElement,
    onHudChange: HudListener,
  ) {
    this.container = container;
    this.onHudChange = onHudChange;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
    });

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color("#132338");

    this.scene.fog = new THREE.Fog("#132338", 30, 130);

    this.createLights();
    this.createTrack();

    this.playerMesh = this.createPlayer();

    this.createWorldActors();
    this.createSnowSystem();

    this.camera.position.set(0, 5.3, 8.5);

    this.resizeObserver = new ResizeObserver(this.resize);

    this.resizeObserver.observe(this.container);

    this.resize();
    this.resetToMenu();

    /*
     * Three.js предоставляет setAnimationLoop
     * как API для управления циклом рендеринга.
     */
    this.renderer.setAnimationLoop(this.animate);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);

    this.resizeObserver.disconnect();
    this.input.dispose();

    const geometries = new Set<THREE.BufferGeometry>();

    const materials = new Set<THREE.Material>();

    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      geometries.add(object.geometry);

      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material];

      objectMaterials.forEach((material) => {
        materials.add(material);
      });
    });

    geometries.forEach((geometry) => {
      geometry.dispose();
    });

    materials.forEach((material) => {
      material.dispose();
    });

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /*
   * -----------------------------------------------------
   * СОЗДАНИЕ СЦЕНЫ
   * -----------------------------------------------------
   */

  private createLights(): void {
    const hemisphereLight = new THREE.HemisphereLight(
      "#b9d8ff",
      "#142014",
      2.2,
    );

    this.scene.add(hemisphereLight);

    const sun = new THREE.DirectionalLight("#ffffff", 3.2);

    sun.position.set(-14, 18, 10);
    sun.castShadow = true;

    sun.shadow.mapSize.set(2048, 2048);

    sun.shadow.camera.left = -25;
    sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -12;
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 60;

    this.scene.add(sun);
  }

  private createTrack(): void {
    const groundGeometry = new THREE.BoxGeometry(8.6, 0.2, TRACK_TILE_LENGTH);

    const groundMaterial = new THREE.MeshStandardMaterial({
      color: "#26354a",
      roughness: 0.92,
    });

    const sideGrassGeometry = new THREE.BoxGeometry(
      24,
      0.18,
      TRACK_TILE_LENGTH,
    );
    const sideGrassMaterial = new THREE.MeshStandardMaterial({
      color: "#162e1e",
      roughness: 0.95,
    });

    const railGeometry = new THREE.BoxGeometry(0.08, 0.08, TRACK_TILE_LENGTH);

    const railMaterial = new THREE.MeshStandardMaterial({
      color: "#9ca7b5",
      roughness: 0.45,
      metalness: 0.75,
    });

    const sleeperGeometry = new THREE.BoxGeometry(1.65, 0.05, 0.15);

    const sleeperMaterial = new THREE.MeshStandardMaterial({
      color: "#463a32",
      roughness: 1,
    });

    for (let index = 0; index < TRACK_TILE_COUNT; index += 1) {
      const tile = new THREE.Group();

      const ground = new THREE.Mesh(groundGeometry, groundMaterial);

      ground.position.y = -0.1;
      ground.receiveShadow = true;

      tile.add(ground);

      const leftGrass = new THREE.Mesh(sideGrassGeometry, sideGrassMaterial);
      leftGrass.position.set(-16.3, -0.11, 0);
      leftGrass.receiveShadow = true;
      tile.add(leftGrass);

      const rightGrass = new THREE.Mesh(sideGrassGeometry, sideGrassMaterial);
      rightGrass.position.set(16.3, -0.11, 0);
      rightGrass.receiveShadow = true;
      tile.add(rightGrass);

      /*
       * По две рельсы на каждую дорожку.
       */
      const railPositions = [-3, -1.8, -0.6, 0.6, 1.8, 3];

      railPositions.forEach((x) => {
        const rail = new THREE.Mesh(railGeometry, railMaterial);

        rail.position.set(x, 0.04, 0);
        rail.castShadow = true;
        rail.receiveShadow = true;

        tile.add(rail);
      });

      /*
       * Индивидуальные деревянные шпалы для каждой из 3-х ж/д путей
       */
      LANE_X.forEach((laneX) => {
        for (let sleeperIndex = 0; sleeperIndex < 10; sleeperIndex += 1) {
          const sleeper = new THREE.Mesh(sleeperGeometry, sleeperMaterial);

          sleeper.position.set(laneX, 0.015, -4.5 + sleeperIndex);

          sleeper.receiveShadow = true;

          tile.add(sleeper);
        }
      });

      /*
       * Элементы окружения (деревья, домики, фонари, кусты) по бокам дороги.
       */
      this.populateTileScenery(tile, index);

      /*
       * Пушистые 3D-облака в небе над дорогой
       */
      if (index % 2 === 0) {
        const cloudLeft = this.createCloud(index);
        cloudLeft.position.set(
          -28 - (index % 4) * 6,
          22 + (index % 3) * 3,
          -2,
        );
        tile.add(cloudLeft);

        const cloudRight = this.createCloud(index + 5);
        cloudRight.position.set(
          28 + (index % 3) * 6,
          20 + (index % 4) * 3,
          1,
        );
        tile.add(cloudRight);
      }

      tile.position.z = 5 - index * TRACK_TILE_LENGTH;

      this.trackTiles.push(tile);
      this.scene.add(tile);
    }
  }

  private createCloud(variantSeed: number): THREE.Group {
    const cloudGroup = new THREE.Group();

    const cloudMat = new THREE.MeshStandardMaterial({
      color: "#f0f4f8",
      emissive: "#a0b4c8",
      emissiveIntensity: 0.35,
      roughness: 0.95,
      flatShading: true,
    });

    const puffCount = 5 + (variantSeed % 3);

    for (let i = 0; i < puffCount; i += 1) {
      const radius = 1.2 + ((variantSeed + i * 3) % 4) * 0.45;
      const puffGeo = new THREE.DodecahedronGeometry(radius, 1);
      const puff = new THREE.Mesh(puffGeo, cloudMat);

      const posX = (i - puffCount / 2) * 1.5 + ((variantSeed * 2 + i) % 3) * 0.3;
      const posY = Math.sin(i * 1.1) * 0.5;
      const posZ = Math.cos(i * 1.3) * 0.6;

      puff.position.set(posX, posY, posZ);
      cloudGroup.add(puff);
    }

    const scale = 1.2 + (variantSeed % 3) * 0.4;
    cloudGroup.scale.set(scale, scale * 0.65, scale);

    return cloudGroup;
  }

  private createTree(variantSeed: number): THREE.Group {
    const group = new THREE.Group();

    const isPine = variantSeed % 2 === 0;

    if (isPine) {
      const trunkGeo = new THREE.CylinderGeometry(0.18, 0.32, 1.8, 8);
      const trunkMat = new THREE.MeshStandardMaterial({
        color: "#3e2723",
        roughness: 0.9,
      });
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 0.9;
      trunk.castShadow = true;
      trunk.receiveShadow = true;
      group.add(trunk);

      const pineGreenPalette = ["#1b4332", "#2d6a4f", "#40916c"];
      const foliageMat = new THREE.MeshStandardMaterial({
        color: pineGreenPalette[variantSeed % pineGreenPalette.length],
        roughness: 0.8,
        flatShading: true,
      });

      const cone1 = new THREE.Mesh(
        new THREE.ConeGeometry(1.25, 1.6, 7),
        foliageMat,
      );
      cone1.position.y = 1.8;
      cone1.castShadow = true;
      cone1.receiveShadow = true;
      group.add(cone1);

      const cone2 = new THREE.Mesh(
        new THREE.ConeGeometry(0.95, 1.4, 7),
        foliageMat,
      );
      cone2.position.y = 2.5;
      cone2.castShadow = true;
      cone2.receiveShadow = true;
      group.add(cone2);

      const cone3 = new THREE.Mesh(
        new THREE.ConeGeometry(0.65, 1.1, 7),
        foliageMat,
      );
      cone3.position.y = 3.2;
      cone3.castShadow = true;
      cone3.receiveShadow = true;
      group.add(cone3);

      // Новогодние светящиеся шары и золотая звезда на вершине
      if (getActiveEnvId() === "newyear") {
        const baubleColors = ["#ff0055", "#ffd700", "#00f5d4", "#ffb703"];
        for (let b = 0; b < 6; b += 1) {
          const bCol = baubleColors[b % baubleColors.length];
          const baubleMat = new THREE.MeshStandardMaterial({
            color: bCol,
            emissive: bCol,
            emissiveIntensity: 1.4,
            roughness: 0.2,
          });
          const bauble = new THREE.Mesh(
            new THREE.SphereGeometry(0.1, 8, 8),
            baubleMat,
          );
          const angle = (b * Math.PI) / 3;
          const r = 0.7 - (b % 3) * 0.2;
          bauble.position.set(
            Math.cos(angle) * r,
            1.8 + (b % 3) * 0.6,
            Math.sin(angle) * r,
          );
          group.add(bauble);
        }

        const starMat = new THREE.MeshStandardMaterial({
          color: "#ffd700",
          emissive: "#ffae00",
          emissiveIntensity: 2.0,
        });
        const star = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.18, 0),
          starMat,
        );
        star.position.y = 3.8;
        group.add(star);
      }
    } else {
      const trunkGeo = new THREE.CylinderGeometry(0.22, 0.38, 2.0, 8);
      const trunkMat = new THREE.MeshStandardMaterial({
        color: "#4a2c11",
        roughness: 0.9,
      });
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 1.0;
      trunk.castShadow = true;
      trunk.receiveShadow = true;
      group.add(trunk);

      const decGreenPalette = [
        "#2e7d32",
        "#388e3c",
        "#43a047",
        "#52b788",
        "#ff9f1c",
      ];
      const foliageMat = new THREE.MeshStandardMaterial({
        color: decGreenPalette[variantSeed % decGreenPalette.length],
        roughness: 0.75,
        flatShading: true,
      });

      const canopyCenter = new THREE.Mesh(
        new THREE.DodecahedronGeometry(1.0, 1),
        foliageMat,
      );
      canopyCenter.position.set(0, 2.4, 0);
      canopyCenter.castShadow = true;
      canopyCenter.receiveShadow = true;
      group.add(canopyCenter);

      const canopySide1 = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.7, 1),
        foliageMat,
      );
      canopySide1.position.set(0.45, 2.2, 0.3);
      canopySide1.castShadow = true;
      group.add(canopySide1);

      const canopySide2 = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.65, 1),
        foliageMat,
      );
      canopySide2.position.set(-0.4, 2.3, -0.3);
      canopySide2.castShadow = true;
      group.add(canopySide2);
    }

    const scale = 0.85 + (variantSeed % 5) * 0.08;
    group.scale.set(scale, scale, scale);
    group.rotation.y = (variantSeed * 1.3) % (Math.PI * 2);

    return group;
  }

  private createHouse(variantSeed: number): THREE.Group {
    const group = new THREE.Group();

    const wallColors = [
      "#f4f1de",
      "#e07a5f",
      "#3d405b",
      "#81b29a",
      "#f2cc8f",
      "#d4a373",
      "#457b9d",
      "#e29578",
    ];
    const roofColors = [
      "#b71c1c",
      "#7f4f24",
      "#2b2d42",
      "#4e342e",
      "#1d3557",
      "#6b705c",
    ];

    const wallColor = wallColors[variantSeed % wallColors.length];
    const roofColor = roofColors[(variantSeed + 2) % roofColors.length];

    const width = 2.4 + (variantSeed % 3) * 0.3;
    const height = 2.2 + ((variantSeed * 3) % 3) * 0.4;
    const depth = 2.6 + ((variantSeed * 2) % 3) * 0.3;

    const bodyGeo = new THREE.BoxGeometry(width, height, depth);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: wallColor,
      roughness: 0.7,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = height / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const roofHeight = 1.3 + (variantSeed % 2) * 0.3;
    const roofGeo = new THREE.ConeGeometry(
      Math.hypot(width, depth) * 0.58,
      roofHeight,
      4,
    );
    const roofMat = new THREE.MeshStandardMaterial({
      color: roofColor,
      roughness: 0.5,
      flatShading: true,
    });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = height + roofHeight / 2;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    roof.receiveShadow = true;
    group.add(roof);

    const doorGeo = new THREE.BoxGeometry(0.65, 1.2, 0.1);
    const doorMat = new THREE.MeshStandardMaterial({
      color: "#3d2314",
      roughness: 0.8,
    });
    const door = new THREE.Mesh(doorGeo, doorMat);
    door.position.set(0, 0.6, depth / 2 + 0.02);
    group.add(door);

    const windowGeo = new THREE.BoxGeometry(0.5, 0.5, 0.08);
    const windowMat = new THREE.MeshStandardMaterial({
      color: "#fff3b0",
      emissive: "#ffd166",
      emissiveIntensity: 0.6,
      roughness: 0.3,
    });

    const winLeft = new THREE.Mesh(windowGeo, windowMat);
    winLeft.position.set(-width * 0.28, height * 0.65, depth / 2 + 0.02);
    group.add(winLeft);

    const winRight = new THREE.Mesh(windowGeo, windowMat);
    winRight.position.set(width * 0.28, height * 0.65, depth / 2 + 0.02);
    group.add(winRight);

    if (variantSeed % 2 === 0) {
      const chimneyGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
      const chimneyMat = new THREE.MeshStandardMaterial({
        color: "#5c3d2e",
        roughness: 0.8,
      });
      const chimney = new THREE.Mesh(chimneyGeo, chimneyMat);
      chimney.position.set(
        width * 0.3,
        height + roofHeight * 0.5,
        -depth * 0.2,
      );
      chimney.castShadow = true;
      group.add(chimney);
    }

    return group;
  }

  private createStreetLamp(): THREE.Group {
    const group = new THREE.Group();

    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 3.2, 8);
    const poleMat = new THREE.MeshStandardMaterial({
      color: "#2b2d42",
      roughness: 0.4,
      metalness: 0.8,
    });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 1.6;
    pole.castShadow = true;
    group.add(pole);

    const bulbGeo = new THREE.SphereGeometry(0.24, 12, 12);
    const bulbMat = new THREE.MeshStandardMaterial({
      color: "#fffae6",
      emissive: "#ffc107",
      emissiveIntensity: 1.2,
      roughness: 0.2,
    });
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.y = 3.2;
    group.add(bulb);

    return group;
  }

  private createBush(variantSeed: number): THREE.Group {
    const group = new THREE.Group();

    const bushPalette = ["#2b9348", "#55a630", "#38b000", "#184e77"];
    const mat = new THREE.MeshStandardMaterial({
      color: bushPalette[variantSeed % bushPalette.length],
      roughness: 0.8,
      flatShading: true,
    });

    const mainBush = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.65, 1),
      mat,
    );
    mainBush.position.y = 0.4;
    mainBush.castShadow = true;
    mainBush.receiveShadow = true;
    group.add(mainBush);

    const sideBush = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.45, 1),
      mat,
    );
    sideBush.position.set(0.4, 0.3, 0.2);
    sideBush.castShadow = true;
    group.add(sideBush);

    return group;
  }

  private createGiftBox(variantSeed: number): THREE.Group {
    const group = new THREE.Group();
    const colors = [
      "#e63946",
      "#2a9d8f",
      "#f4a261",
      "#7c3aed",
      "#e07a5f",
      "#00b4d8",
      "#ff006e",
      "#457b9d",
    ];
    const boxColor = colors[Math.abs(variantSeed) % colors.length];

    const boxMat = new THREE.MeshStandardMaterial({
      color: boxColor,
      roughness: 0.4,
    });

    const ribbonColors = ["#ffd700", "#ffffff", "#ffae00", "#00f5d4"];
    const ribbonColor = ribbonColors[Math.abs(variantSeed * 3) % ribbonColors.length];

    const ribbonMat = new THREE.MeshStandardMaterial({
      color: ribbonColor,
      emissive: ribbonColor,
      emissiveIntensity: 0.4,
      metalness: 0.7,
      roughness: 0.2,
    });

    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.32, 0.38),
      boxMat,
    );
    box.position.y = 0.16;
    box.castShadow = true;
    group.add(box);

    const stripe1 = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.33, 0.08),
      ribbonMat,
    );
    stripe1.position.y = 0.16;
    group.add(stripe1);

    const stripe2 = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.33, 0.4),
      ribbonMat,
    );
    stripe2.position.y = 0.16;
    group.add(stripe2);

    const bow = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.09, 0),
      ribbonMat,
    );
    bow.position.y = 0.35;
    group.add(bow);

    return group;
  }

  private createPumpkin(variantSeed: number): THREE.Group {
    const group = new THREE.Group();

    const orangeShades = [
      "#ff6600",
      "#e65100",
      "#ff7b00",
      "#f57c00",
      "#d84315",
      "#ff8f00",
    ];
    const pumpkinColor = orangeShades[Math.abs(variantSeed) % orangeShades.length];

    const pumpkinMat = new THREE.MeshStandardMaterial({
      color: pumpkinColor,
      roughness: 0.5,
    });
    const stemMat = new THREE.MeshStandardMaterial({
      color: "#2d6a4f",
      roughness: 0.8,
    });
    const faceMat = new THREE.MeshStandardMaterial({
      color: "#ffae00",
      emissive: "#ff3300",
      emissiveIntensity: 2.2,
    });

    const body = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.32, 1),
      pumpkinMat,
    );
    body.scale.set(1.1, 0.85, 1.1);
    body.position.y = 0.22;
    body.castShadow = true;
    group.add(body);

    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.06, 0.14, 6),
      stemMat,
    );
    stem.position.set(0, 0.4, 0);
    stem.rotation.z = (variantSeed % 3) * 0.15 - 0.15;
    group.add(stem);

    const eyeL = new THREE.Mesh(
      new THREE.ConeGeometry(0.05, 0.08, 3),
      faceMat,
    );
    eyeL.rotation.x = Math.PI / 2;
    eyeL.position.set(-0.1, 0.26, 0.28);
    group.add(eyeL);

    const eyeR = new THREE.Mesh(
      new THREE.ConeGeometry(0.05, 0.08, 3),
      faceMat,
    );
    eyeR.rotation.x = Math.PI / 2;
    eyeR.position.set(0.1, 0.26, 0.28);
    group.add(eyeR);

    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.05, 0.04),
      faceMat,
    );
    mouth.position.set(0, 0.16, 0.29);
    group.add(mouth);

    return group;
  }

  private createGhost(): THREE.Group {
    const group = new THREE.Group();

    const ghostMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      emissive: "#e2e8f0",
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.88,
      roughness: 0.2,
    });
    const eyeMat = new THREE.MeshStandardMaterial({
      color: "#0f172a",
      roughness: 0.9,
    });

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 12, 12),
      ghostMat,
    );
    head.position.y = 0.75;
    group.add(head);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.32, 0.45, 12),
      ghostMat,
    );
    body.position.y = 0.48;
    group.add(body);

    const eyeL = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 8, 8),
      eyeMat,
    );
    eyeL.position.set(-0.08, 0.78, 0.21);
    group.add(eyeL);

    const eyeR = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 8, 8),
      eyeMat,
    );
    eyeR.position.set(0.08, 0.78, 0.21);
    group.add(eyeR);

    return group;
  }

  private createGravestone(): THREE.Group {
    const group = new THREE.Group();

    const stoneMat = new THREE.MeshStandardMaterial({
      color: "#6c757d",
      roughness: 0.8,
    });
    const crossMat = new THREE.MeshStandardMaterial({
      color: "#343a40",
      roughness: 0.9,
    });

    const stone = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.52, 0.12),
      stoneMat,
    );
    stone.position.y = 0.26;
    stone.castShadow = true;
    group.add(stone);

    const crossV = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.26, 0.04),
      crossMat,
    );
    crossV.position.set(0, 0.3, 0.07);
    group.add(crossV);

    const crossH = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.05, 0.04),
      crossMat,
    );
    crossH.position.set(0, 0.34, 0.07);
    group.add(crossH);

    return group;
  }

  private addScenery(tile: THREE.Group, obj: THREE.Object3D): void {
    obj.userData.isScenery = true;
    tile.add(obj);
  }

  private spawnHalloweenScenery(tile: THREE.Group, tileIndex: number): void {
    const leftPattern = (tileIndex * 3 + 1) % 6;
    const rightPattern = (tileIndex * 5 + 4) % 6;

    this.spawnPumpkinClusterOnSide(tile, tileIndex, -1, leftPattern);
    this.spawnPumpkinClusterOnSide(tile, tileIndex, 1, rightPattern);

    if (tileIndex % 3 === 0) {
      const ghost = this.createGhost();
      const side = (tileIndex / 3) % 2 === 0 ? -1 : 1;
      const ghostX = side * (6.5 + (tileIndex % 3) * 0.5);
      const ghostZ = ((tileIndex * 2) % 7) - 3;
      ghost.position.set(ghostX, 1.2 + (tileIndex % 2) * 0.4, ghostZ);
      ghost.userData.baseY = ghost.position.y;
      this.ghostMeshes.push(ghost as unknown as THREE.Mesh);
      this.addScenery(tile, ghost);
    }

    if (tileIndex % 2 === 1) {
      const gravestone = this.createGravestone();
      const side = tileIndex % 4 < 2 ? -1 : 1;
      const stoneX = side * (7.6 + (tileIndex % 2) * 0.6);
      const stoneZ = ((tileIndex * 4) % 7) - 3;
      gravestone.position.set(stoneX, 0, stoneZ);
      gravestone.rotation.y = (tileIndex * 0.7) % 0.8 - 0.4;
      this.addScenery(tile, gravestone);
    }
  }

  private spawnPumpkinClusterOnSide(
    tile: THREE.Group,
    tileIndex: number,
    sideSign: number,
    pattern: number,
  ): void {
    if (pattern === 0) {
      // STACKED PUMPKINS (2-3 pumpkins, 1 stacked on top)
      const clusterGroup = new THREE.Group();
      const baseX = sideSign * (6.2 + (tileIndex % 3) * 0.4);
      const baseZ = ((tileIndex * 3) % 7) - 3;
      clusterGroup.position.set(baseX, 0, baseZ);

      const baseSeed = tileIndex * 7;
      const baseP = this.createPumpkin(baseSeed);
      const baseScale = 1.35 + (tileIndex % 3) * 0.15;
      baseP.scale.set(baseScale, baseScale, baseScale);
      baseP.rotation.y = (sideSign > 0 ? -Math.PI / 4 : Math.PI / 4) + (tileIndex % 5) * 0.1;
      clusterGroup.add(baseP);

      const topSeed = baseSeed + 1;
      const topP = this.createPumpkin(topSeed);
      const topScale = 0.75 + (tileIndex % 2) * 0.1;
      topP.scale.set(topScale, topScale, topScale);
      topP.position.set(0.05 * sideSign, 0.38 * baseScale, 0.02);
      topP.rotation.z = sideSign * 0.18;
      topP.rotation.x = -0.12;
      topP.rotation.y = sideSign > 0 ? -Math.PI / 3 : Math.PI / 3;
      clusterGroup.add(topP);

      if (tileIndex % 2 === 0) {
        const miniP = this.createPumpkin(baseSeed + 2);
        const miniScale = 0.55;
        miniP.scale.set(miniScale, miniScale, miniScale);
        miniP.position.set(-0.35 * sideSign, 0, 0.25);
        miniP.rotation.y = Math.PI / 6;
        clusterGroup.add(miniP);
      }

      this.addScenery(tile, clusterGroup);
    } else if (pattern === 1) {
      // TRIO CLUSTER (3 pumpkins side by side in an arc)
      const clusterGroup = new THREE.Group();
      const baseX = sideSign * (6.5 + (tileIndex % 2) * 0.5);
      const baseZ = ((tileIndex * 5) % 7) - 3;
      clusterGroup.position.set(baseX, 0, baseZ);

      const seed = tileIndex * 11;
      const mainP = this.createPumpkin(seed);
      mainP.scale.set(1.2, 1.2, 1.2);
      mainP.rotation.y = sideSign > 0 ? -Math.PI / 4 : Math.PI / 4;
      clusterGroup.add(mainP);

      const p2 = this.createPumpkin(seed + 1);
      p2.scale.set(0.85, 0.85, 0.85);
      p2.position.set(-0.38 * sideSign, 0, -0.32);
      p2.rotation.y = sideSign > 0 ? -Math.PI / 6 : Math.PI / 6;
      clusterGroup.add(p2);

      const p3 = this.createPumpkin(seed + 2);
      p3.scale.set(0.65, 0.65, 0.65);
      p3.position.set(0.35 * sideSign, 0, 0.28);
      p3.rotation.y = sideSign > 0 ? -Math.PI / 3 : Math.PI / 3;
      clusterGroup.add(p3);

      this.addScenery(tile, clusterGroup);
    } else if (pattern === 2) {
      // GIANT SOLO PUMPKIN
      const giantP = this.createPumpkin(tileIndex * 13);
      const giantScale = 1.65 + (tileIndex % 3) * 0.15;
      giantP.scale.set(giantScale, giantScale, giantScale);
      const posX = sideSign * (6.8 + (tileIndex % 2) * 0.4);
      const posZ = ((tileIndex * 4) % 7) - 3;
      giantP.position.set(posX, 0, posZ);
      giantP.rotation.y = (sideSign > 0 ? -Math.PI / 3 : Math.PI / 3) + (tileIndex % 4) * 0.15;
      giantP.rotation.z = sideSign * 0.08;
      this.addScenery(tile, giantP);
    } else if (pattern === 3) {
      // PAIR OF PUMPKINS
      const clusterGroup = new THREE.Group();
      const baseX = sideSign * (6.3 + (tileIndex % 3) * 0.3);
      const baseZ = ((tileIndex * 2) % 7) - 3;
      clusterGroup.position.set(baseX, 0, baseZ);

      const seed = tileIndex * 17;
      const p1 = this.createPumpkin(seed);
      p1.scale.set(1.1, 1.1, 1.1);
      p1.rotation.y = sideSign > 0 ? -Math.PI / 5 : Math.PI / 5;
      clusterGroup.add(p1);

      const p2 = this.createPumpkin(seed + 1);
      p2.scale.set(0.75, 0.75, 0.75);
      p2.position.set(0.32 * sideSign, 0, 0.22);
      p2.rotation.y = sideSign > 0 ? -Math.PI / 2.5 : Math.PI / 2.5;
      clusterGroup.add(p2);

      this.addScenery(tile, clusterGroup);
    } else if (pattern === 4) {
      // STACKED PAIR (2 pumpkins stacked straight)
      const clusterGroup = new THREE.Group();
      const baseX = sideSign * (6.6 + (tileIndex % 2) * 0.5);
      const baseZ = ((tileIndex * 6) % 7) - 3;
      clusterGroup.position.set(baseX, 0, baseZ);

      const baseP = this.createPumpkin(tileIndex * 19);
      baseP.scale.set(1.25, 1.25, 1.25);
      baseP.rotation.y = sideSign > 0 ? -Math.PI / 4 : Math.PI / 4;
      clusterGroup.add(baseP);

      const topP = this.createPumpkin(tileIndex * 19 + 1);
      topP.scale.set(0.7, 0.7, 0.7);
      topP.position.set(0, 0.38 * 1.25, 0);
      topP.rotation.y = sideSign > 0 ? -Math.PI / 2 : Math.PI / 2;
      topP.rotation.x = 0.1;
      clusterGroup.add(topP);

      this.addScenery(tile, clusterGroup);
    }
  }

  private spawnNewYearScenery(tile: THREE.Group, tileIndex: number): void {
    const leftPattern = (tileIndex * 4 + 2) % 6;
    const rightPattern = (tileIndex * 6 + 1) % 6;

    this.spawnGiftClusterOnSide(tile, tileIndex, -1, leftPattern);
    this.spawnGiftClusterOnSide(tile, tileIndex, 1, rightPattern);
  }

  private spawnGiftClusterOnSide(
    tile: THREE.Group,
    tileIndex: number,
    sideSign: number,
    pattern: number,
  ): void {
    if (pattern === 0) {
      // TRIPLE STACK (Tower of 3 presents)
      const clusterGroup = new THREE.Group();
      const baseX = sideSign * (6.5 + (tileIndex % 3) * 0.4);
      const baseZ = ((tileIndex * 3) % 7) - 3;
      clusterGroup.position.set(baseX, 0, baseZ);

      const seed = tileIndex * 5;
      const g1 = this.createGiftBox(seed);
      const s1 = 1.4;
      g1.scale.set(s1, s1, s1);
      g1.rotation.y = (tileIndex % 4) * 0.2;
      clusterGroup.add(g1);

      const g2 = this.createGiftBox(seed + 1);
      const s2 = 0.95;
      g2.scale.set(s2, s2, s2);
      g2.position.set(0, 0.35 * s1, 0);
      g2.rotation.y = g1.rotation.y + 0.45;
      clusterGroup.add(g2);

      const g3 = this.createGiftBox(seed + 2);
      const s3 = 0.6;
      g3.scale.set(s3, s3, s3);
      g3.position.set(0, 0.35 * s1 + 0.35 * s2, 0);
      g3.rotation.y = g2.rotation.y - 0.6;
      clusterGroup.add(g3);

      this.addScenery(tile, clusterGroup);
    } else if (pattern === 1) {
      // GIANT PRESENT
      const giantG = this.createGiftBox(tileIndex * 9);
      const giantScale = 1.8 + (tileIndex % 3) * 0.2;
      giantG.scale.set(giantScale, giantScale, giantScale);
      const posX = sideSign * (6.8 + (tileIndex % 2) * 0.4);
      const posZ = ((tileIndex * 4) % 7) - 3;
      giantG.position.set(posX, 0, posZ);
      giantG.rotation.y = (tileIndex * 0.8) % (Math.PI * 2);
      this.addScenery(tile, giantG);
    } else if (pattern === 2) {
      // HEAP OF GIFTS (4 gifts)
      const clusterGroup = new THREE.Group();
      const baseX = sideSign * (6.3 + (tileIndex % 2) * 0.5);
      const baseZ = ((tileIndex * 5) % 7) - 3;
      clusterGroup.position.set(baseX, 0, baseZ);

      const seed = tileIndex * 13;
      const g1 = this.createGiftBox(seed);
      g1.scale.set(1.2, 1.2, 1.2);
      g1.rotation.y = (tileIndex % 3) * 0.3;
      clusterGroup.add(g1);

      const g2 = this.createGiftBox(seed + 1);
      g2.scale.set(0.75, 0.75, 0.75);
      g2.position.set(-0.35 * sideSign, 0, -0.28);
      g2.rotation.y = g1.rotation.y + 0.5;
      clusterGroup.add(g2);

      const g3 = this.createGiftBox(seed + 2);
      g3.scale.set(0.65, 0.65, 0.65);
      g3.position.set(0.32 * sideSign, 0, 0.25);
      g3.rotation.y = g1.rotation.y - 0.4;
      clusterGroup.add(g3);

      const g4 = this.createGiftBox(seed + 3);
      g4.scale.set(0.5, 0.5, 0.5);
      g4.position.set(0.1 * sideSign, 0, 0.35);
      g4.rotation.y = g1.rotation.y + 1.2;
      clusterGroup.add(g4);

      this.addScenery(tile, clusterGroup);
    } else if (pattern === 3) {
      // DOUBLE STACK (2 gifts stacked)
      const clusterGroup = new THREE.Group();
      const baseX = sideSign * (6.6 + (tileIndex % 3) * 0.3);
      const baseZ = ((tileIndex * 2) % 7) - 3;
      clusterGroup.position.set(baseX, 0, baseZ);

      const seed = tileIndex * 17;
      const g1 = this.createGiftBox(seed);
      const s1 = 1.3;
      g1.scale.set(s1, s1, s1);
      g1.rotation.y = (tileIndex % 5) * 0.25;
      clusterGroup.add(g1);

      const g2 = this.createGiftBox(seed + 1);
      const s2 = 0.8;
      g2.scale.set(s2, s2, s2);
      g2.position.set(0, 0.35 * s1, 0);
      g2.rotation.y = g1.rotation.y + 0.6;
      clusterGroup.add(g2);

      this.addScenery(tile, clusterGroup);
    } else if (pattern === 4) {
      // PAIR SIDE-BY-SIDE
      const clusterGroup = new THREE.Group();
      const baseX = sideSign * (6.4 + (tileIndex % 2) * 0.4);
      const baseZ = ((tileIndex * 4) % 7) - 3;
      clusterGroup.position.set(baseX, 0, baseZ);

      const seed = tileIndex * 19;
      const g1 = this.createGiftBox(seed);
      g1.scale.set(1.0, 1.0, 1.0);
      g1.rotation.y = 0.2;
      clusterGroup.add(g1);

      const g2 = this.createGiftBox(seed + 1);
      g2.scale.set(0.75, 0.75, 0.75);
      g2.position.set(0.3 * sideSign, 0, 0.2);
      g2.rotation.y = 0.7;
      clusterGroup.add(g2);

      this.addScenery(tile, clusterGroup);
    }
  }

  private populateTileScenery(tile: THREE.Group, tileIndex: number): void {
    const leftVariant = tileIndex;
    const rightVariant = tileIndex + 7;

    // --- LEFT SIDE SCENERY ---
    if (tileIndex % 3 === 0) {
      const house = this.createHouse(leftVariant);
      house.position.set(-11.8, 0, -1.5);
      house.rotation.y = Math.PI / 2 + 0.1;
      this.addScenery(tile, house);

      const tree = this.createTree(leftVariant);
      tree.position.set(-9.2, 0, 3.2);
      this.addScenery(tile, tree);

      const bush = this.createBush(leftVariant);
      bush.position.set(-7.2, 0, -1.0);
      this.addScenery(tile, bush);
    } else if (tileIndex % 3 === 1) {
      const tree1 = this.createTree(leftVariant);
      tree1.position.set(-9.0, 0, -2.8);
      this.addScenery(tile, tree1);

      const tree2 = this.createTree(leftVariant + 1);
      tree2.position.set(-12.5, 0, 2.2);
      this.addScenery(tile, tree2);

      const lamp = this.createStreetLamp();
      lamp.position.set(-6.6, 0, 0);
      lamp.rotation.y = Math.PI / 2;
      this.addScenery(tile, lamp);

      const bush = this.createBush(leftVariant + 2);
      bush.position.set(-8.0, 0, 3.5);
      this.addScenery(tile, bush);
    } else {
      const house = this.createHouse(leftVariant + 3);
      house.position.set(-12.5, 0, 2.0);
      house.rotation.y = Math.PI / 2 - 0.15;
      this.addScenery(tile, house);

      const tree1 = this.createTree(leftVariant + 2);
      tree1.position.set(-8.8, 0, -3.2);
      this.addScenery(tile, tree1);

      const tree2 = this.createTree(leftVariant + 4);
      tree2.position.set(-14.2, 0, -1.2);
      this.addScenery(tile, tree2);
    }

    // --- RIGHT SIDE SCENERY ---
    if ((tileIndex + 1) % 3 === 0) {
      const house = this.createHouse(rightVariant);
      house.position.set(11.8, 0, 1.5);
      house.rotation.y = -Math.PI / 2 - 0.1;
      this.addScenery(tile, house);

      const tree1 = this.createTree(rightVariant + 1);
      tree1.position.set(9.2, 0, -2.5);
      this.addScenery(tile, tree1);

      const tree2 = this.createTree(rightVariant + 2);
      tree2.position.set(13.8, 0, 3.8);
      this.addScenery(tile, tree2);
    } else if ((tileIndex + 1) % 3 === 1) {
      const tree1 = this.createTree(rightVariant);
      tree1.position.set(10.0, 0, 2.2);
      this.addScenery(tile, tree1);

      const tree2 = this.createTree(rightVariant + 1);
      tree2.position.set(13.0, 0, -2.2);
      this.addScenery(tile, tree2);

      const lamp = this.createStreetLamp();
      lamp.position.set(6.6, 0, 0);
      lamp.rotation.y = -Math.PI / 2;
      this.addScenery(tile, lamp);

      const bush = this.createBush(rightVariant + 3);
      bush.position.set(7.5, 0, -3.0);
      this.addScenery(tile, bush);
    } else {
      const house = this.createHouse(rightVariant + 2);
      house.position.set(12.5, 0, -2.0);
      house.rotation.y = -Math.PI / 2 + 0.12;
      this.addScenery(tile, house);

      const tree1 = this.createTree(rightVariant + 3);
      tree1.position.set(9.0, 0, 2.6);
      this.addScenery(tile, tree1);

      const bush = this.createBush(rightVariant + 4);
      bush.position.set(7.2, 0, 0.8);
      this.addScenery(tile, bush);
    }

    // --- THEMATIC DECORATIVE PROPS ---
    const envId = getActiveEnvId();

    if (envId === "newyear") {
      this.spawnNewYearScenery(tile, tileIndex);
    } else if (envId === "halloween") {
      this.spawnHalloweenScenery(tile, tileIndex);
    }
  }

  private createPlayer(): THREE.Mesh {
    this.humanoidGroup = new THREE.Group();

    const activeSkin = SKINS_CATALOG.find((s) => s.id === getActiveSkinId()) || SKINS_CATALOG[0];

    const skinMat = new THREE.MeshStandardMaterial({
      color: "#ffdbac",
      roughness: 0.6,
    });

    const hairMat = new THREE.MeshStandardMaterial({
      color: "#2c1a11",
      roughness: 0.7,
    });

    this.visorMat = new THREE.MeshStandardMaterial({
      color: activeSkin.visorColor,
      emissive: activeSkin.visorColor,
      emissiveIntensity: 1.2,
      roughness: 0.1,
    });

    this.hoodieMat = new THREE.MeshStandardMaterial({
      color: activeSkin.hoodieColor,
      roughness: 0.45,
      metalness: 0.1,
    });

    const zipperMat = new THREE.MeshStandardMaterial({
      color: "#f8f9fa",
      metalness: 0.9,
      roughness: 0.2,
    });

    this.pantsMat = new THREE.MeshStandardMaterial({
      color: activeSkin.pantsColor,
      roughness: 0.5,
    });

    const shoeMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.3,
    });

    const soleMat = new THREE.MeshStandardMaterial({
      color: "#ff5722",
      roughness: 0.4,
    });

    this.backpackMat = new THREE.MeshStandardMaterial({
      color: activeSkin.backpackColor,
      roughness: 0.4,
      metalness: 0.6,
    });

    const gloveMat = new THREE.MeshStandardMaterial({
      color: "#212529",
      roughness: 0.5,
    });

    // --- ТОРС И КУРТКА-ХУДИ ---
    const torsoMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.62, 0.32),
      this.hoodieMat,
    );
    torsoMesh.position.y = 1.15;
    torsoMesh.castShadow = true;
    this.humanoidGroup.add(torsoMesh);

    const zipper = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.6, 0.04),
      zipperMat,
    );
    zipper.position.set(0, 1.15, 0.15);
    this.humanoidGroup.add(zipper);

    const backpack = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.42, 0.18),
      this.backpackMat,
    );
    backpack.position.set(0, 1.18, -0.21);
    backpack.castShadow = true;
    this.humanoidGroup.add(backpack);

    const batteryLight = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.06, 0.04),
      new THREE.MeshStandardMaterial({
        color: "#00ff88",
        emissive: "#00ff88",
        emissiveIntensity: 1.5,
      }),
    );
    batteryLight.position.set(0, 1.3, -0.31);
    this.humanoidGroup.add(batteryLight);

    // --- ГОЛОВА И ПРИЧЕСКА ---
    const headMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.36, 0.34),
      skinMat,
    );
    headMesh.position.y = 1.62;
    headMesh.castShadow = true;
    this.humanoidGroup.add(headMesh);

    const hairMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.14, 0.36),
      hairMat,
    );
    hairMesh.position.set(0, 1.76, -0.01);
    this.humanoidGroup.add(hairMesh);

    const bangs = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.08, 0.12),
      hairMat,
    );
    bangs.position.set(0, 1.72, 0.14);
    this.humanoidGroup.add(bangs);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.09, 0.08),
      this.visorMat,
    );
    visor.position.set(0, 1.63, 0.15);
    this.humanoidGroup.add(visor);

    // --- РУКИ (С ГИБКИМИ ПЛЕЧЕВЫМИ СУСТАВАМИ) ---
    this.leftArmGroup = new THREE.Group();
    this.leftArmGroup.position.set(-0.33, 1.38, 0);

    const leftSleeve = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.44, 0.14),
      this.hoodieMat,
    );
    leftSleeve.position.y = -0.22;
    leftSleeve.castShadow = true;
    this.leftArmGroup.add(leftSleeve);

    const leftHand = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 10, 10),
      gloveMat,
    );
    leftHand.position.y = -0.46;
    this.leftArmGroup.add(leftHand);

    this.humanoidGroup.add(this.leftArmGroup);

    this.rightArmGroup = new THREE.Group();
    this.rightArmGroup.position.set(0.33, 1.38, 0);

    const rightSleeve = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.44, 0.14),
      this.hoodieMat,
    );
    rightSleeve.position.y = -0.22;
    rightSleeve.castShadow = true;
    this.rightArmGroup.add(rightSleeve);

    const rightHand = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 10, 10),
      gloveMat,
    );
    rightHand.position.y = -0.46;
    this.rightArmGroup.add(rightHand);

    this.humanoidGroup.add(this.rightArmGroup);

    // --- НОГИ И КРОССОВКИ ---
    this.leftLegGroup = new THREE.Group();
    this.leftLegGroup.position.set(-0.15, 0.82, 0);

    const leftPant = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.62, 0.18),
      this.pantsMat,
    );
    leftPant.position.y = -0.31;
    leftPant.castShadow = true;
    this.leftLegGroup.add(leftPant);

    const leftShoe = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.14, 0.32),
      shoeMat,
    );
    leftShoe.position.set(0, -0.65, 0.05);
    leftShoe.castShadow = true;
    this.leftLegGroup.add(leftShoe);

    const leftSole = new THREE.Mesh(
      new THREE.BoxGeometry(0.21, 0.05, 0.33),
      soleMat,
    );
    leftSole.position.set(0, -0.73, 0.05);
    this.leftLegGroup.add(leftSole);

    this.humanoidGroup.add(this.leftLegGroup);

    this.rightLegGroup = new THREE.Group();
    this.rightLegGroup.position.set(0.15, 0.82, 0);

    const rightPant = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.62, 0.18),
      this.pantsMat,
    );
    rightPant.position.y = -0.31;
    rightPant.castShadow = true;
    this.rightLegGroup.add(rightPant);

    const rightShoe = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.14, 0.32),
      shoeMat,
    );
    rightShoe.position.set(0, -0.65, 0.05);
    rightShoe.castShadow = true;
    this.rightLegGroup.add(rightShoe);

    const rightSole = new THREE.Mesh(
      new THREE.BoxGeometry(0.21, 0.05, 0.33),
      soleMat,
    );
    rightSole.position.set(0, -0.73, 0.05);
    this.rightLegGroup.add(rightSole);

    this.humanoidGroup.add(this.rightLegGroup);

    this.playerGroup.add(this.humanoidGroup);

    // Невидимый хитбокс для коллизий
    const hitGeometry = new THREE.BoxGeometry(PLAYER_WIDTH, PLAYER_STANDING_HEIGHT, PLAYER_DEPTH);
    const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const body = new THREE.Mesh(hitGeometry, hitMaterial);
    body.position.y = PLAYER_STANDING_HEIGHT / 2;
    this.playerGroup.add(body);

    /*
     * Светящаяся полупрозрачная аура щита вокруг игрока
     */
    const shieldGeo = new THREE.IcosahedronGeometry(1.25, 2);
    const shieldMat = new THREE.MeshStandardMaterial({
      color: "#58ef91",
      emissive: "#00ff88",
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.38,
      roughness: 0.1,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    this.shieldAuraMesh = new THREE.Mesh(shieldGeo, shieldMat);
    this.shieldAuraMesh.position.y = 0.9;
    this.shieldAuraMesh.visible = false;
    this.playerGroup.add(this.shieldAuraMesh);

    this.scene.add(this.playerGroup);

    return body;
  }

  private createWorldActors(): void {
    const trainKinds: TrainKind[] = [
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
      "flat",
      "ramp",
    ];

    trainKinds.forEach((kind) => {
      this.trains.push(this.createTrain(kind));
    });

    // 48 Препятствий (24 низких барьера, 24 лазерных арки подката) для высокого уровня сложности
    for (let index = 0; index < 24; index += 1) {
      this.obstacles.push(this.createObstacle("low"));
      this.obstacles.push(this.createObstacle("overhead"));
    }

    // 50 Независимых монет на дороге
    for (let index = 0; index < 50; index += 1) {
      this.pickups.push(this.createPickup("coin", true));
    }

    // 5 Магнитов, 5 Щитов
    for (let index = 0; index < 5; index += 1) {
      this.pickups.push(this.createPickup("magnet", true));
      this.pickups.push(this.createPickup("shield", true));
    }
  }

  private createTrain(kind: TrainKind): TrainActor {
    const root = new THREE.Group();

    this.scene.add(root);

    const bodyColor = kind === "flat" ? "#d90429" : "#0077b6";

    const bodyMat = new THREE.MeshStandardMaterial({
      color: bodyColor,
      roughness: 0.38,
      metalness: 0.35,
    });

    const darkSteelMat = new THREE.MeshStandardMaterial({
      color: "#161b22",
      roughness: 0.5,
      metalness: 0.8,
    });

    const silverStripeMat = new THREE.MeshStandardMaterial({
      color: "#f8f9fa",
      roughness: 0.25,
      metalness: 0.9,
    });

    const windowGlassMat = new THREE.MeshStandardMaterial({
      color: "#fff3b0",
      emissive: "#ffd166",
      emissiveIntensity: 0.65,
      roughness: 0.2,
    });

    const headlightMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      emissive: "#ffea00",
      emissiveIntensity: 2.2,
    });

    if (kind === "flat") {
      /*
       * 1. Основной двухцветный корпус поезда
       */
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(TRAIN_WIDTH, TRAIN_HEIGHT, TRAIN_LENGTH),
        bodyMat,
      );
      body.position.y = TRAIN_HEIGHT / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      root.add(body);

      /*
       * 2. Металлические молдинги по бокам поезда
       */
      const stripeLeft = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.22, TRAIN_LENGTH - 0.2),
        silverStripeMat,
      );
      stripeLeft.position.set(-TRAIN_WIDTH / 2 - 0.01, TRAIN_HEIGHT * 0.48, 0);
      root.add(stripeLeft);

      const stripeRight = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.22, TRAIN_LENGTH - 0.2),
        silverStripeMat,
      );
      stripeRight.position.set(TRAIN_WIDTH / 2 + 0.01, TRAIN_HEIGHT * 0.48, 0);
      root.add(stripeRight);

      /*
       * 3. Светящиеся боковые окна вагона
       */
      for (let zIndex = -2.5; zIndex <= 2.5; zIndex += 1.6) {
        const winL = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.48, 0.9),
          windowGlassMat,
        );
        winL.position.set(-TRAIN_WIDTH / 2 - 0.01, TRAIN_HEIGHT * 0.68, zIndex);
        root.add(winL);

        const winR = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.48, 0.9),
          windowGlassMat,
        );
        winR.position.set(TRAIN_WIDTH / 2 + 0.01, TRAIN_HEIGHT * 0.68, zIndex);
        root.add(winR);
      }

      /*
       * 4. Яркие фары спереди
       */
      const lightGeo = new THREE.SphereGeometry(0.11, 12, 12);

      const headLeft = new THREE.Mesh(lightGeo, headlightMat);
      headLeft.position.set(-TRAIN_WIDTH * 0.32, 0.45, TRAIN_LENGTH / 2 + 0.02);
      root.add(headLeft);

      const headRight = new THREE.Mesh(lightGeo, headlightMat);
      headRight.position.set(TRAIN_WIDTH * 0.32, 0.45, TRAIN_LENGTH / 2 + 0.02);
      root.add(headRight);

      /*
       * 5. Колесные тележки (подвеска)
       */
      for (const zPos of [-TRAIN_LENGTH * 0.32, TRAIN_LENGTH * 0.32]) {
        const bogey = new THREE.Mesh(
          new THREE.BoxGeometry(TRAIN_WIDTH * 0.9, 0.25, 1.4),
          darkSteelMat,
        );
        bogey.position.set(0, 0.125, zPos);
        bogey.castShadow = true;
        root.add(bogey);
      }

      /*
       * 6. Крышевой блок кондиционирования
       */
      const vent = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.1, 1.6),
        darkSteelMat,
      );
      vent.position.set(0, TRAIN_HEIGHT + 0.05, 0);
      root.add(vent);
    } else {
      /*
       * Рамповый поезд с наклонным въездом
       */
      const chassisHeight = 0.18;
      const chassis = new THREE.Mesh(
        new THREE.BoxGeometry(TRAIN_WIDTH, chassisHeight, TRAIN_LENGTH),
        darkSteelMat,
      );
      chassis.position.y = chassisHeight / 2;
      chassis.castShadow = true;
      chassis.receiveShadow = true;
      root.add(chassis);

      const bodyLength = TRAIN_LENGTH - RAMP_LENGTH;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(TRAIN_WIDTH, TRAIN_HEIGHT, bodyLength),
        bodyMat,
      );
      body.position.set(0, TRAIN_HEIGHT / 2, -RAMP_LENGTH / 2);
      body.castShadow = true;
      body.receiveShadow = true;
      root.add(body);

      // Боковые окна вагона
      for (let zIndex = -RAMP_LENGTH / 2 - 0.8; zIndex >= -TRAIN_LENGTH / 2 + 0.8; zIndex -= 1.4) {
        const winL = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.45, 0.8),
          windowGlassMat,
        );
        winL.position.set(-TRAIN_WIDTH / 2 - 0.01, TRAIN_HEIGHT * 0.68, zIndex);
        root.add(winL);

        const winR = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.45, 0.8),
          windowGlassMat,
        );
        winR.position.set(TRAIN_WIDTH / 2 + 0.01, TRAIN_HEIGHT * 0.68, zIndex);
        root.add(winR);
      }

      // Наклонная рампа
      const slopeLength = Math.hypot(RAMP_LENGTH, TRAIN_HEIGHT);
      const slopeAngle = Math.atan2(TRAIN_HEIGHT, RAMP_LENGTH);

      const ramp = new THREE.Mesh(
        new THREE.BoxGeometry(TRAIN_WIDTH, RAMP_THICKNESS, slopeLength),
        new THREE.MeshStandardMaterial({
          color: "#0096c7",
          roughness: 0.35,
          metalness: 0.4,
        }),
      );
      ramp.rotation.x = slopeAngle;
      ramp.position.set(
        0,
        TRAIN_HEIGHT / 2 - (RAMP_THICKNESS / 2) * Math.cos(slopeAngle),
        TRAIN_LENGTH / 2 - RAMP_LENGTH / 2,
      );
      ramp.castShadow = true;
      ramp.receiveShadow = true;
      root.add(ramp);

      // Предупредительный желтый порожек у основания рампы
      const rampBaseStrip = new THREE.Mesh(
        new THREE.BoxGeometry(TRAIN_WIDTH + 0.04, 0.06, 0.25),
        new THREE.MeshStandardMaterial({
          color: "#ffb703",
          emissive: "#fb8500",
          emissiveIntensity: 0.6,
        }),
      );
      rampBaseStrip.position.set(0, 0.04, TRAIN_LENGTH / 2 - 0.1);
      root.add(rampBaseStrip);
    }

    const train: TrainActor = {
      kind,
      root,
      box: new THREE.Box3(),
      roofPickups: [],
    };

    const pickupPositions =
      kind === "flat" ? [2.5, 0, -2.5] : [3.25, 2.2, 1.15, 0.1, -2];

    pickupPositions.forEach((localZ) => {
      const pickup = this.createPickup("coin", false);
      pickup.mesh.userData.localZ = localZ;

      const surfaceHeight = this.getLocalTrainSurfaceHeight(kind, localZ);

      pickup.mesh.position.set(
        0,
        (surfaceHeight ?? TRAIN_HEIGHT) + 0.55,
        localZ,
      );

      root.add(pickup.mesh);

      train.roofPickups.push(pickup);
      this.pickups.push(pickup);
    });

    return train;
  }

  private createObstacle(kind: ObstacleKind): ObstacleActor {
    const root = new THREE.Group();

    let size: THREE.Vector3;

    if (kind === "low") {
      size = new THREE.Vector3(1.55, 0.8, 0.55);

      // Тяжелые металлические ножки-опоры
      const footMat = new THREE.MeshStandardMaterial({
        color: "#1b263b",
        roughness: 0.3,
        metalness: 0.8,
      });

      const footGeo = new THREE.BoxGeometry(0.24, 0.18, 0.7);
      const footLeft = new THREE.Mesh(footGeo, footMat);
      footLeft.position.set(-size.x / 2 + 0.12, -size.y / 2 + 0.09, 0);
      footLeft.castShadow = true;
      root.add(footLeft);

      const footRight = new THREE.Mesh(footGeo, footMat);
      footRight.position.set(size.x / 2 - 0.12, -size.y / 2 + 0.09, 0);
      footRight.castShadow = true;
      root.add(footRight);

      // Вертикальные стойки барьера
      const postMat = new THREE.MeshStandardMaterial({
        color: "#2b2d42",
        roughness: 0.4,
        metalness: 0.6,
      });

      const postGeo = new THREE.BoxGeometry(0.12, size.y, 0.18);
      const postLeft = new THREE.Mesh(postGeo, postMat);
      postLeft.position.set(-size.x / 2 + 0.12, 0, 0);
      postLeft.castShadow = true;
      root.add(postLeft);

      const postRight = new THREE.Mesh(postGeo, postMat);
      postRight.position.set(size.x / 2 - 0.12, 0, 0);
      postRight.castShadow = true;
      root.add(postRight);

      // Светящиеся сигнальные маячки на вершине
      const beaconMat = new THREE.MeshStandardMaterial({
        color: "#ff0055",
        emissive: "#ff0055",
        emissiveIntensity: 1.8,
      });
      const beaconGeo = new THREE.SphereGeometry(0.09, 12, 12);

      const beaconLeft = new THREE.Mesh(beaconGeo, beaconMat);
      beaconLeft.position.set(-size.x / 2 + 0.12, size.y / 2 + 0.09, 0);
      root.add(beaconLeft);

      const beaconRight = new THREE.Mesh(beaconGeo, beaconMat);
      beaconRight.position.set(size.x / 2 - 0.12, size.y / 2 + 0.09, 0);
      root.add(beaconRight);

      // Основная планка барьера
      const barMat = new THREE.MeshStandardMaterial({
        color: "#ffb703",
        emissive: "#fb8500",
        emissiveIntensity: 0.4,
        roughness: 0.4,
      });

      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(size.x - 0.1, 0.36, 0.12),
        barMat,
      );
      bar.position.set(0, 0.08, 0);
      bar.castShadow = true;
      root.add(bar);

      // Диагональные черные предупредительные полосы
      const stripeMat = new THREE.MeshStandardMaterial({
        color: "#1a1a1a",
        roughness: 0.8,
      });
      for (let i = -2; i <= 2; i += 1) {
        const stripe = new THREE.Mesh(
          new THREE.BoxGeometry(0.08, 0.38, 0.14),
          stripeMat,
        );
        stripe.position.set(i * 0.26, 0.08, 0);
        stripe.rotation.z = Math.PI / 6;
        root.add(stripe);
      }

      // Нижняя усилительная перекладина
      const rodMat = new THREE.MeshStandardMaterial({
        color: "#8d99ae",
        metalness: 0.85,
        roughness: 0.3,
      });
      const rod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, size.x - 0.1, 12),
        rodMat,
      );
      rod.rotation.z = Math.PI / 2;
      rod.position.set(0, -0.22, 0);
      rod.castShadow = true;
      root.add(rod);
    } else {
      /*
       * Высокая арка для подката с полупрозрачной неоновой лазерной сеткой:
       * - Просвет снизу: y = 0 до y = 0.92 (подкат проходит свободно).
       * - Высота силового поля: от y = 0.92 до y = 3.3.
       * - Полупрозрачный экран (opacity: 0.35) отлично виден игроку (понятно, что перепрыгнуть нельзя),
       *   но абсолютно НЕ перекрывает обзор дороги и камеры!
       */
      size = new THREE.Vector3(1.7, 2.38, 0.35);

      const frameMat = new THREE.MeshStandardMaterial({
        color: "#2c2a38",
        roughness: 0.4,
        metalness: 0.7,
      });

      const clearanceY = 0.92;
      const barrierTopY = 3.3;
      const screenHeight = barrierTopY - clearanceY;

      const upperBeam = new THREE.Mesh(
        new THREE.BoxGeometry(size.x, 0.16, size.z),
        frameMat,
      );
      upperBeam.position.y = barrierTopY - 0.08;
      upperBeam.castShadow = true;
      root.add(upperBeam);

      const lowerBeam = new THREE.Mesh(
        new THREE.BoxGeometry(size.x, 0.16, size.z),
        frameMat,
      );
      lowerBeam.position.y = clearanceY + 0.08;
      lowerBeam.castShadow = true;
      root.add(lowerBeam);

      const screenMat = new THREE.MeshStandardMaterial({
        color: "#ff0055",
        emissive: "#ff0055",
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.35,
        roughness: 0.2,
      });

      const laserScreen = new THREE.Mesh(
        new THREE.BoxGeometry(size.x - 0.1, screenHeight - 0.2, 0.08),
        screenMat,
      );
      laserScreen.position.y = clearanceY + screenHeight / 2;
      root.add(laserScreen);



      const legGeo = new THREE.BoxGeometry(0.14, barrierTopY, size.z);
      const legLeft = new THREE.Mesh(legGeo, frameMat);
      legLeft.position.set(-size.x / 2 + 0.07, barrierTopY / 2, 0);
      legLeft.castShadow = true;
      legLeft.receiveShadow = true;
      root.add(legLeft);

      const legRight = new THREE.Mesh(legGeo, frameMat);
      legRight.position.set(size.x / 2 - 0.07, barrierTopY / 2, 0);
      legRight.castShadow = true;
      legRight.receiveShadow = true;
      root.add(legRight);

      const lightGeo = new THREE.SphereGeometry(0.14, 10, 10);
      const lightMat = new THREE.MeshStandardMaterial({
        color: "#ff0055",
        emissive: "#ff0055",
        emissiveIntensity: 1.5,
      });

      const lightLeft = new THREE.Mesh(lightGeo, lightMat);
      lightLeft.position.set(-size.x * 0.42, barrierTopY + 0.12, 0);
      root.add(lightLeft);

      const lightRight = new THREE.Mesh(lightGeo, lightMat);
      lightRight.position.set(size.x * 0.42, barrierTopY + 0.12, 0);
      root.add(lightRight);
    }

    this.scene.add(root);

    return {
      kind,
      mesh: root,
      size,
      box: new THREE.Box3(),
    };
  }

  private createPickup(kind: PickupKind, independent: boolean): PickupActor {
    const root = new THREE.Group();

    if (kind === "coin") {
      const geometry = new THREE.CylinderGeometry(0.28, 0.28, 0.08, 20);
      const material = new THREE.MeshStandardMaterial({
        color: "#ffd447",
        emissive: "#6b3e00",
        emissiveIntensity: 0.8,
        roughness: 0.3,
        metalness: 0.5,
      });

      const coinMesh = new THREE.Mesh(geometry, material);
      coinMesh.rotation.x = Math.PI / 2;
      coinMesh.castShadow = true;
      root.add(coinMesh);

      const ringGeo = new THREE.TorusGeometry(0.28, 0.03, 8, 20);
      const ringMat = new THREE.MeshStandardMaterial({
        color: "#ffffff",
        emissive: "#ffe57f",
        emissiveIntensity: 1.0,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      root.add(ring);
    } else if (kind === "magnet") {
      /*
       * Реалистичный 3D-магнит подкова (красно-серебряный), стоящий дугой вверх (U-образный)
       */
      const magnetRedMat = new THREE.MeshStandardMaterial({
        color: "#e63946",
        emissive: "#800f2f",
        emissiveIntensity: 0.5,
        roughness: 0.3,
      });
      const silverMat = new THREE.MeshStandardMaterial({
        color: "#f1faee",
        emissive: "#a8dadc",
        emissiveIntensity: 0.4,
        roughness: 0.2,
        metalness: 0.85,
      });

      // U-образная дуга на вершине (дуга смотрит ВВЕРХ!)
      const archGeo = new THREE.TorusGeometry(0.3, 0.09, 12, 24, Math.PI);
      const arch = new THREE.Mesh(archGeo, magnetRedMat);
      arch.rotation.x = 0; // Не переворачиваем! Дуга смотрит вверх
      arch.position.y = 0.15;
      arch.castShadow = true;
      root.add(arch);

      // Левая ножка идет ВНИЗ от дуги
      const legGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.28, 12);
      const legLeft = new THREE.Mesh(legGeo, magnetRedMat);
      legLeft.position.set(-0.3, -0.01, 0);
      legLeft.castShadow = true;
      root.add(legLeft);

      // Серебряный наконечник в самом низу левой ножки
      const tipLeft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.095, 0.095, 0.14, 12),
        silverMat,
      );
      tipLeft.position.set(-0.3, -0.21, 0);
      tipLeft.castShadow = true;
      root.add(tipLeft);

      // Правая ножка идет ВНИЗ от дуги
      const legRight = new THREE.Mesh(legGeo, magnetRedMat);
      legRight.position.set(0.3, -0.01, 0);
      legRight.castShadow = true;
      root.add(legRight);

      // Серебряный наконечник в самом низу правой ножки
      const tipRight = new THREE.Mesh(
        new THREE.CylinderGeometry(0.095, 0.095, 0.14, 12),
        silverMat,
      );
      tipRight.position.set(0.3, -0.21, 0);
      tipRight.castShadow = true;
      root.add(tipRight);

      // Легкий наклон магнита в сторону камеры для лучшего обзора
      root.rotation.x = 0.35;
    } else {
      /*
       * Реалистичный 3D-щит (геральдический щит с эмблемой и серебряным ободком)
       */
      const shieldMat = new THREE.MeshStandardMaterial({
        color: "#58ef91",
        emissive: "#00ff88",
        emissiveIntensity: 0.9,
        roughness: 0.25,
        metalness: 0.2,
      });
      const rimMat = new THREE.MeshStandardMaterial({
        color: "#f8f9fa",
        emissive: "#ced4da",
        emissiveIntensity: 0.4,
        roughness: 0.2,
        metalness: 0.85,
      });

      const plateGeo = new THREE.CylinderGeometry(0.42, 0.18, 0.08, 5);
      const plate = new THREE.Mesh(plateGeo, shieldMat);
      plate.rotation.x = Math.PI / 2;
      plate.rotation.z = Math.PI;
      plate.castShadow = true;
      root.add(plate);

      const rimGeo = new THREE.TorusGeometry(0.38, 0.04, 8, 24);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.castShadow = true;
      root.add(rim);

      const emblemMat = new THREE.MeshStandardMaterial({
        color: "#ffffff",
        emissive: "#ffffff",
        emissiveIntensity: 1.4,
      });
      const emblem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.18, 0),
        emblemMat,
      );
      emblem.position.z = 0.05;
      root.add(emblem);
    }

    if (independent) {
      this.scene.add(root);
    }

    return {
      kind,
      mesh: root,
      independent,
    };
  }

  /*
   * -----------------------------------------------------
   * ОСНОВНОЙ ЦИКЛ
   * -----------------------------------------------------
   */

  private readonly animate = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.05);

    if (!this.isGameActive || this.gameOver) {
      if (this.gameOver && this.input.consume("restart")) {
        this.startGame();
      }

      this.updateCamera(delta);
    } else {
      this.update(delta);
    }

    this.renderer.render(this.scene, this.camera);

    this.input.endFrame();
  };

  private update(delta: number): void {
    this.hitCooldown = Math.max(0, this.hitCooldown - delta);

    this.magnetRemaining = Math.max(0, this.magnetRemaining - delta);

    const currentSpeed = this.getCurrentWorldSpeed();
    this.distance += currentSpeed * delta;

    this.updateControls(delta);
    this.updateWorld(delta);
    this.updateVerticalPhysics(delta);
    this.updatePlayerVisual(delta);
    this.updateSnowSystem(delta);
    this.updateGhosts();

    this.updatePlayerBox();
    this.checkPickups();
    this.checkHazards();

    this.updateCamera(delta);

    this.hudUpdateAccumulator += delta;

    if (this.hudUpdateAccumulator >= 0.1) {
      this.hudUpdateAccumulator = 0;
      this.emitHud();
    }
  }

  /*
   * -----------------------------------------------------
   * УПРАВЛЕНИЕ ИГРОКОМ
   * -----------------------------------------------------
   */

  private updateControls(delta: number): void {
    if (this.input.consume("left")) {
      this.currentLane = Math.max(0, this.currentLane - 1) as LaneIndex;
    }

    if (this.input.consume("right")) {
      this.currentLane = Math.min(2, this.currentLane + 1) as LaneIndex;
    }

    if (this.input.consume("jump") && this.grounded) {
      this.grounded = false;
      this.sliding = false;
      this.slideRemaining = 0;
      this.verticalVelocity = JUMP_VELOCITY;
    }

    if (this.input.consume("slide")) {
      if (this.grounded) {
        this.sliding = true;
        this.slideRemaining = SLIDE_DURATION;
      } else {
        /*
         * Нажатие вниз во время прыжка
         * ускоряет падение.
         */
        this.verticalVelocity = Math.min(
          this.verticalVelocity,
          FAST_FALL_VELOCITY,
        );
      }
    }

    if (this.sliding) {
      this.slideRemaining -= delta;

      if (this.slideRemaining <= 0) {
        this.sliding = false;
        this.slideRemaining = 0;
      }
    }

    const targetX = LANE_X[this.currentLane];

    this.playerX = damp(this.playerX, targetX, LANE_CHANGE_SPEED, delta);
  }

  /*
   * -----------------------------------------------------
   * ФИЗИКА ПРЫЖКА И ПЛАТФОРМ
   * -----------------------------------------------------
   */

  private updateVerticalPhysics(delta: number): void {
    if (this.grounded) {
      const supportHeight = this.findCurrentSupportHeight();

      if (supportHeight === null) {
        /*
         * Поезд выехал из-под игрока.
         */
        this.grounded = false;
      } else {
        /*
         * Подстраиваем высоту ног
         * под землю, крышу или рампу.
         */
        this.playerFeetY = supportHeight;

        this.verticalVelocity = 0;
      }
    }

    if (this.grounded) {
      return;
    }

    const previousFeetY = this.playerFeetY;

    this.verticalVelocity += GRAVITY * delta;

    const nextFeetY = this.playerFeetY + this.verticalVelocity * delta;

    const landingHeight = this.findLandingHeight(previousFeetY, nextFeetY);

    if (landingHeight !== null) {
      this.playerFeetY = landingHeight;

      this.verticalVelocity = 0;
      this.grounded = true;

      return;
    }

    this.playerFeetY = nextFeetY;
  }

  /**
   * Возвращает высоту поверхности поезда
   * для локальной координаты Z.
   *
   * localZ:
   *
   * -TRAIN_LENGTH / 2  — зад поезда
   * +TRAIN_LENGTH / 2  — перед поезда
   */
  private getLocalTrainSurfaceHeight(
    kind: TrainKind,
    localZ: number,
  ): number | null {
    const halfLength = TRAIN_LENGTH / 2;

    if (localZ < -halfLength || localZ > halfLength) {
      return null;
    }

    if (kind === "flat") {
      return TRAIN_HEIGHT;
    }

    /*
     * Рампа находится в передней части.
     */
    const rampFrontZ = halfLength;

    const rampBackZ = rampFrontZ - RAMP_LENGTH;

    /*
     * Задняя часть рампового поезда —
     * обычная плоская крыша.
     */
    if (localZ <= rampBackZ) {
      return TRAIN_HEIGHT;
    }

    /*
     * В начале рампы:
     *
     * localZ = rampFrontZ
     * progress = 0
     * height = 0
     *
     * В конце рампы:
     *
     * localZ = rampBackZ
     * progress = 1
     * height = TRAIN_HEIGHT
     */
    const progress = (rampFrontZ - localZ) / RAMP_LENGTH;

    return THREE.MathUtils.clamp(progress, 0, 1) * TRAIN_HEIGHT;
  }

  private getTrainSurfaceHeight(train: TrainActor): number | null {
    const deltaX = Math.abs(this.playerX - train.root.position.x);

    /*
     * Разрешаем допуск по ширине до половины ширины игрока,
     * чтобы персонаж мог плавно бежать по крыше поезда и переходить
     * на соседнюю полосу без резких провалов.
     */
    if (deltaX > TRAIN_WIDTH / 2 + PLAYER_WIDTH * 0.5) {
      return null;
    }

    return this.getTrainLocalSurfaceHeight(train);
  }

  private getTrainLocalSurfaceHeight(train: TrainActor): number | null {
    const localZ = -train.root.position.z;

    const halfLength = TRAIN_LENGTH / 2;

    /*
     * Небольшой допуск нужен, чтобы персонаж
     * мог мягко заехать на самый край рампы.
     */
    const edgeTolerance = PLAYER_DEPTH / 2;

    if (
      localZ < -halfLength - edgeTolerance ||
      localZ > halfLength + edgeTolerance
    ) {
      return null;
    }

    const clampedLocalZ = THREE.MathUtils.clamp(
      localZ,
      -halfLength,
      halfLength,
    );

    return this.getLocalTrainSurfaceHeight(train.kind, clampedLocalZ);
  }

  private findCurrentSupportHeight(): number | null {
    const candidates: number[] = [0];

    for (const train of this.trains) {
      const surfaceHeight = this.getTrainSurfaceHeight(train);

      if (surfaceHeight !== null) {
        candidates.push(surfaceHeight);
      }
    }

    let bestHeight: number | null = null;

    for (const height of candidates) {
      const stepUp = height - this.playerFeetY;

      const stepDown = this.playerFeetY - height;

      /*
       * Небольшое изменение высоты разрешено.
       *
       * Благодаря этому персонаж поднимается
       * по рампе.
       *
       * Но вертикальный поезд высотой 1.55
       * нельзя преодолеть как ступеньку.
       */
      if (stepUp > MAX_GROUNDED_STEP_UP || stepDown > MAX_GROUNDED_STEP_DOWN) {
        continue;
      }

      bestHeight = bestHeight === null ? height : Math.max(bestHeight, height);
    }

    return bestHeight;
  }

  private findLandingHeight(
    previousFeetY: number,
    nextFeetY: number,
  ): number | null {
    /*
     * Пока игрок летит вверх,
     * приземления быть не может.
     */
    if (this.verticalVelocity > 0) {
      return null;
    }

    const candidates: number[] = [0];

    for (const train of this.trains) {
      const surfaceHeight = this.getTrainSurfaceHeight(train);

      if (surfaceHeight !== null) {
        candidates.push(surfaceHeight);
      }
    }

    let landingHeight: number | null = null;

    for (const height of candidates) {
      /*
       * За один кадр ноги пересекли поверхность
       * сверху вниз.
       */
      const crossedSurface = previousFeetY >= height && nextFeetY <= height;

      if (!crossedSurface) {
        continue;
      }

      landingHeight =
        landingHeight === null ? height : Math.max(landingHeight, height);
    }

    return landingHeight;
  }

  /*
   * -----------------------------------------------------
   * ВИЗУАЛ ИГРОКА
   * -----------------------------------------------------
   */

  private updatePlayerVisual(delta = 0.016): void {
    const height = this.getPlayerHeight();

    this.playerMesh.scale.set(PLAYER_WIDTH, height, PLAYER_DEPTH);
    this.playerMesh.position.y = height / 2;

    this.playerGroup.position.set(this.playerX, this.playerFeetY, 0);

    // --- ПРОЦЕДУРНАЯ АНИМАЦИЯ БЕГА, ПРЫЖКА И ПОДКАТА ГУМАНОИДА ---
    if (this.sliding) {
      // Истинный подкат: корпус отклоняется НАЗАД, а ноги вытягиваются ВПЕРЕД по ходу движения
      this.humanoidGroup.position.y = -0.55;
      this.humanoidGroup.rotation.x = -0.75;

      this.leftLegGroup.rotation.x = 1.35;
      this.rightLegGroup.rotation.x = 1.25;

      this.leftArmGroup.rotation.x = 0.8;
      this.rightArmGroup.rotation.x = 0.8;
    } else if (!this.grounded) {
      // Прыжок: туловище подается вперед, ноги поджимаются, руки разводятся для баланса
      this.humanoidGroup.position.y = 0;
      this.humanoidGroup.rotation.x = 0.12;

      this.leftLegGroup.rotation.x = 0.35;
      this.rightLegGroup.rotation.x = -0.25;

      this.leftArmGroup.rotation.x = -0.6;
      this.rightArmGroup.rotation.x = -0.6;
    } else {
      // Спокойный, плавный бег по земле с естественной низкой частотой маха ног
      this.humanoidGroup.rotation.x = 0.06;

      const runCycle = this.distance * 2.8;
      this.humanoidGroup.position.y = Math.abs(Math.sin(runCycle * 2)) * 0.03;

      this.leftArmGroup.rotation.x = Math.sin(runCycle) * 0.45;
      this.rightArmGroup.rotation.x = -Math.sin(runCycle) * 0.45;

      this.leftLegGroup.rotation.x = -Math.sin(runCycle) * 0.45;
      this.rightLegGroup.rotation.x = Math.sin(runCycle) * 0.45;
    }

    /*
     * Анимация светящейся ауры силового поля щита
     */
    this.shieldAuraMesh.visible = this.shieldActive;
    if (this.shieldActive) {
      const time = this.clock.getElapsedTime();
      const pulse = 1 + 0.06 * Math.sin(time * 8);
      this.shieldAuraMesh.scale.set(pulse, pulse, pulse);
      this.shieldAuraMesh.rotation.y += 1.8 * delta;
      this.shieldAuraMesh.rotation.z += 0.8 * delta;
    }
  }

  private getPlayerHeight(): number {
    return this.sliding ? PLAYER_SLIDING_HEIGHT : PLAYER_STANDING_HEIGHT;
  }

  private updatePlayerBox(): void {
    const height = this.getPlayerHeight();

    this.playerBox.min.set(
      this.playerX - PLAYER_WIDTH / 2,
      this.playerFeetY,
      -PLAYER_DEPTH / 2,
    );

    this.playerBox.max.set(
      this.playerX + PLAYER_WIDTH / 2,
      this.playerFeetY + height,
      PLAYER_DEPTH / 2,
    );
  }

  /*
   * -----------------------------------------------------
   * ДВИЖЕНИЕ МИРА
   * -----------------------------------------------------
   */

  private updateWorld(delta: number): void {
    const currentSpeed = this.getCurrentWorldSpeed();
    const movement = currentSpeed * delta;

    this.spawnCursorZ += movement;

    this.updateTrack(movement);

    for (const train of this.trains) {
      const extraSpeed = train.isMoving ? 7.0 : 0;
      train.root.position.z += (currentSpeed + extraSpeed) * delta;

      if (train.root.position.z > RECYCLE_Z) {
        this.respawnTrain(train);
      }

      train.roofPickups.forEach((pickup) => {
        pickup.mesh.rotation.y += 2.8 * delta;
      });
    }

    for (const obstacle of this.obstacles) {
      obstacle.mesh.position.z += movement;

      if (obstacle.mesh.position.z > RECYCLE_Z) {
        this.respawnObstacle(obstacle);
      }
    }

    const playerTargetY = this.playerFeetY + this.getPlayerHeight() * 0.55;

    for (const pickup of this.pickups) {
      pickup.mesh.rotation.y += 2.8 * delta;

      /*
       * Эффект магнита: монеты притягиваются и летят прямо к игроку
       */
      if (
        pickup.kind === "coin" &&
        this.magnetRemaining > 0 &&
        pickup.mesh.visible
      ) {
        pickup.mesh.getWorldPosition(this.temporaryWorldPosition);

        const deltaX = this.playerX - this.temporaryWorldPosition.x;
        const deltaY = playerTargetY - this.temporaryWorldPosition.y;
        const deltaZ = 0 - this.temporaryWorldPosition.z;

        const distanceSquared =
          deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;

        if (distanceSquared < 144) {
          if (!pickup.independent) {
            this.scene.add(pickup.mesh);
            pickup.mesh.position.copy(this.temporaryWorldPosition);
            pickup.independent = true;
          }

          const distance = Math.sqrt(distanceSquared);
          const pullSpeed = Math.max(22, 38 - distance * 1.2);
          const step = Math.min(distance, pullSpeed * delta);

          const dirX = deltaX / distance;
          const dirY = deltaY / distance;
          const dirZ = deltaZ / distance;

          pickup.mesh.position.x += dirX * step;
          pickup.mesh.position.y += dirY * step;
          pickup.mesh.position.z += dirZ * step;

          pickup.mesh.rotation.y += 8 * delta;
          pickup.mesh.rotation.z += 6 * delta;

          continue;
        }
      }

      if (!pickup.independent) {
        continue;
      }

      pickup.mesh.position.z += movement;

      if (pickup.mesh.position.z > RECYCLE_Z) {
        this.respawnPickup(pickup);
      }
    }

    this.updateCoinEffects(delta);
  }

  private triggerCoinPickupFX(x: number, y: number, z: number): void {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // Разлетающиеся звёздочки и искры
    const particleMat = new THREE.MeshStandardMaterial({
      color: "#ffd700",
      emissive: "#ffae00",
      emissiveIntensity: 1.4,
      roughness: 0.2,
    });

    const particles: CoinParticle[] = [];
    const particleCount = 10;

    for (let i = 0; i < particleCount; i += 1) {
      const isStar = i % 2 === 0;
      const geo = isStar
        ? new THREE.OctahedronGeometry(0.09 + Math.random() * 0.04, 0)
        : new THREE.BoxGeometry(0.08, 0.08, 0.08);

      const pMesh = new THREE.Mesh(geo, particleMat);
      pMesh.castShadow = false;
      group.add(pMesh);

      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI;
      const speed = 4.0 + Math.random() * 5.0;

      const vx = Math.cos(theta) * Math.cos(phi) * speed;
      const vy = Math.sin(phi) * speed + 2.5;
      const vz = Math.sin(theta) * Math.cos(phi) * speed;

      particles.push({
        mesh: pMesh,
        velocity: new THREE.Vector3(vx, vy, vz),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 12,
        ),
      });
    }

    this.scene.add(group);

    this.coinEffects.push({
      group,
      particles,
      age: 0,
      maxAge: 0.45,
    });
  }

  private triggerShieldShatterFX(x: number, y: number, z: number): void {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    const particleMat = new THREE.MeshStandardMaterial({
      color: "#58ef91",
      emissive: "#00ff88",
      emissiveIntensity: 2.8,
      roughness: 0.1,
      metalness: 0.2,
    });

    const particles: CoinParticle[] = [];
    const particleCount = 26;

    for (let i = 0; i < particleCount; i += 1) {
      const geo = new THREE.IcosahedronGeometry(0.12 + Math.random() * 0.08, 0);
      const pMesh = new THREE.Mesh(geo, particleMat);
      group.add(pMesh);

      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI;
      const speed = 6.0 + Math.random() * 7.0;

      const vx = Math.cos(theta) * Math.cos(phi) * speed;
      const vy = Math.sin(phi) * speed;
      const vz = Math.sin(theta) * Math.cos(phi) * speed;

      particles.push({
        mesh: pMesh,
        velocity: new THREE.Vector3(vx, vy, vz),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 16,
        ),
      });
    }

    this.scene.add(group);
    this.coinEffects.push({
      group,
      particles,
      age: 0,
      maxAge: 0.55,
    });

    this.playSound(destroyAudio);

    if (window.Telegram?.WebApp?.HapticFeedback) {
      try {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred("warning");
      } catch (err) {
        // Fallback
      }
    }
  }

  private triggerObstacleDestroyFX(x: number, y: number, z: number): void {
    const group = new THREE.Group();
    group.position.set(x, y, z);

    const colors = ["#ffb703", "#fb8500", "#ff0055", "#1b263b", "#1a1a1a"];
    const particles: CoinParticle[] = [];
    const particleCount = 32;

    for (let i = 0; i < particleCount; i += 1) {
      const col = colors[i % colors.length];
      const particleMat = new THREE.MeshStandardMaterial({
        color: col,
        emissive: col === "#ffb703" || col === "#ff0055" ? col : "#000000",
        emissiveIntensity: 0.6,
        roughness: 0.4,
      });

      const size = 0.1 + Math.random() * 0.18;
      const geo = new THREE.BoxGeometry(size, size, size);
      const pMesh = new THREE.Mesh(geo, particleMat);
      group.add(pMesh);

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5;
      const speed = 5.0 + Math.random() * 9.0;

      const vx = Math.cos(theta) * Math.cos(phi) * speed;
      const vy = Math.sin(phi) * speed + 3.0;
      const vz = Math.sin(theta) * Math.cos(phi) * speed - 2.0;

      particles.push({
        mesh: pMesh,
        velocity: new THREE.Vector3(vx, vy, vz),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 20,
          (Math.random() - 0.5) * 20,
          (Math.random() - 0.5) * 20,
        ),
      });
    }

    this.scene.add(group);
    this.coinEffects.push({
      group,
      particles,
      age: 0,
      maxAge: 0.65,
    });
  }

  private updateCoinEffects(delta: number): void {
    for (let i = this.coinEffects.length - 1; i >= 0; i -= 1) {
      const effect = this.coinEffects[i];
      effect.age += delta;

      const progress = effect.age / effect.maxAge;

      if (progress >= 1.0) {
        this.scene.remove(effect.group);
        this.coinEffects.splice(i, 1);
        continue;
      }

      for (const p of effect.particles) {
        p.mesh.position.addScaledVector(p.velocity, delta);
        p.velocity.y -= 9.8 * delta;

        p.mesh.rotation.x += p.spin.x * delta;
        p.mesh.rotation.y += p.spin.y * delta;

        const pScale = Math.max(0, 1.0 - progress * 1.1);
        p.mesh.scale.setScalar(pScale);
      }
    }
  }

  private updateTrack(movement: number): void {
    const totalLength = TRACK_TILE_COUNT * TRACK_TILE_LENGTH;

    for (const tile of this.trackTiles) {
      tile.position.z += movement;

      if (tile.position.z > 15) {
        tile.position.z -= totalLength;
      }
    }
  }

  /*
   * -----------------------------------------------------
   * БОНУСЫ
   * -----------------------------------------------------
   */

  private checkPickups(): void {
    const playerCenterY = this.playerFeetY + this.getPlayerHeight() * 0.55;

    for (const pickup of this.pickups) {
      if (!pickup.mesh.visible) {
        continue;
      }

      pickup.mesh.getWorldPosition(this.temporaryWorldPosition);

      const deltaX = this.temporaryWorldPosition.x - this.playerX;

      const deltaY = this.temporaryWorldPosition.y - playerCenterY;

      const deltaZ = this.temporaryWorldPosition.z;

      const distanceSquared =
        deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;

      const threshold = pickup.kind === "coin" ? 0.95 : 0.85;

      if (distanceSquared < threshold) {
        this.collectPickup(pickup);
      }
    }
  }

  private collectPickup(pickup: PickupActor): void {
    if (pickup.kind === "coin") {
      this.coins += 1;
      addWalletCoins(1);
      this.playSound(coinAudio);

      pickup.mesh.getWorldPosition(this.temporaryWorldPosition);
      this.triggerCoinPickupFX(
        this.temporaryWorldPosition.x,
        this.temporaryWorldPosition.y,
        this.temporaryWorldPosition.z,
      );
    }

    if (pickup.kind === "magnet") {
      this.magnetRemaining = 6;
      this.playSound(magnetAudio);
    }

    if (pickup.kind === "shield") {
      this.shieldActive = true;
      this.playSound(shieldAudio);
    }

    pickup.mesh.visible = false;

    /*
     * Обычный бонус сразу перемещается далеко вперёд.
     * Монета на крыше остаётся скрытой до переиспользования
     * самого поезда.
     */
    if (pickup.independent) {
      this.respawnPickup(pickup);
    }

    this.emitHud(true);
  }

  /*
   * -----------------------------------------------------
   * СТОЛКНОВЕНИЯ
   * -----------------------------------------------------
   */

  private checkHazards(): void {
    if (this.hitCooldown > 0 || this.gameOver) {
      return;
    }

    for (const obstacle of this.obstacles) {
      this.updateObstacleBox(obstacle);

      if (!this.playerBox.intersectsBox(obstacle.box)) {
        continue;
      }

      const survived = this.handleCollision();

      if (survived) {
        this.triggerShieldShatterFX(this.playerX, this.playerFeetY + 0.9, 0);
        obstacle.mesh.getWorldPosition(this.temporaryWorldPosition);
        this.triggerObstacleDestroyFX(
          this.temporaryWorldPosition.x,
          this.temporaryWorldPosition.y + 0.5,
          this.temporaryWorldPosition.z,
        );
        this.respawnObstacle(obstacle);
      }

      return;
    }

    for (const train of this.trains) {
      this.updateTrainBox(train);

      if (!this.playerBox.intersectsBox(train.box)) {
        continue;
      }

      const localSurfaceHeight = this.getTrainLocalSurfaceHeight(train);

      /*
       * Игрок безопасен, когда его ноги находятся
       * на уровне поверхности поезда или выше (бежит по крыше,
       * съезжает с поезда или меняет полосу).
       */
      const isAboveOrAtSurface =
        localSurfaceHeight !== null &&
        this.playerFeetY >= localSurfaceHeight - SURFACE_TOLERANCE;

      if (isAboveOrAtSurface) {
        continue;
      }

      /*
       * Поверхность выше ног игрока —
       * значит он ударился в боковую часть.
       */
      const survived = this.handleCollision();

      if (survived) {
        this.triggerShieldShatterFX(this.playerX, this.playerFeetY + 0.9, 0);
        this.respawnTrain(train);
      }

      return;
    }
  }

  private handleCollision(): boolean {
    if (this.shieldActive) {
      this.shieldActive = false;
      this.hitCooldown = 1;

      this.emitHud(true);

      return true;
    }

    this.gameOver = true;
    this.playSound(failAudio);
    this.emitHud(true);

    return false;
  }

  private updateObstacleBox(obstacle: ObstacleActor): void {
    const position = obstacle.mesh.position;

    if (obstacle.kind === "overhead") {
      /*
       * Для арки подката:
       * - Просвет снизу: от y = 0 до y = 0.92 (проходим подкатом).
       * - Высота зоны коллизии: от y = 0.92 до y = 15.0.
       * Никакой прыжок не может перелететь этот барьер,
       * а визуальная модель остается тонкой и не закрывает обзор камеры.
       */
      obstacle.box.min.set(
        position.x - obstacle.size.x / 2,
        0.92,
        position.z - obstacle.size.z / 2,
      );

      obstacle.box.max.set(
        position.x + obstacle.size.x / 2,
        15.0,
        position.z + obstacle.size.z / 2,
      );
    } else {
      obstacle.box.min.set(
        position.x - obstacle.size.x / 2,
        position.y - obstacle.size.y / 2,
        position.z - obstacle.size.z / 2,
      );

      obstacle.box.max.set(
        position.x + obstacle.size.x / 2,
        position.y + obstacle.size.y / 2,
        position.z + obstacle.size.z / 2,
      );
    }
  }

  private updateTrainBox(train: TrainActor): void {
    const position = train.root.position;

    train.box.min.set(
      position.x - TRAIN_WIDTH / 2,
      position.y,
      position.z - TRAIN_LENGTH / 2,
    );

    train.box.max.set(
      position.x + TRAIN_WIDTH / 2,
      position.y + TRAIN_HEIGHT,
      position.z + TRAIN_LENGTH / 2,
    );
  }

  /*
   * -----------------------------------------------------
   * ГЕНЕРАЦИЯ И ПЕРЕИСПОЛЬЗОВАНИЕ
   * -----------------------------------------------------
   */

  private allocateSpawnZ(minimumGap: number, maximumGap: number): number {
    this.spawnCursorZ -= THREE.MathUtils.randFloat(minimumGap, maximumGap);

    return this.spawnCursorZ;
  }

  private respawnTrain(train: TrainActor): void {
    train.isMoving = false;
    let attempts = 0;
    let selectedLane = randomLane();
    let candidateZ = this.spawnCursorZ;
    let valid = false;

    while (attempts < 20 && !valid) {
      attempts += 1;
      selectedLane = randomLane();
      candidateZ = this.spawnCursorZ - THREE.MathUtils.randFloat(5.5, 9.5);
      valid = true;

      const laneX = LANE_X[selectedLane];

      // Проверка перекрытия с другими поездами на той же полосе
      for (const other of this.trains) {
        if (other === train || !other.root.visible) continue;
        if (Math.abs(other.root.position.x - laneX) < 0.5) {
          const distZ = Math.abs(other.root.position.z - candidateZ);
          if (distZ < TRAIN_LENGTH + 6.0) {
            valid = false;
            break;
          }
        }
      }
    }

    this.spawnCursorZ = Math.min(this.spawnCursorZ, candidateZ);

    train.root.position.set(
      LANE_X[selectedLane],
      0,
      candidateZ,
    );

    train.roofPickups.forEach((pickup) => {
      if (pickup.mesh.parent !== train.root) {
        train.root.add(pickup.mesh);
        pickup.independent = false;

        const localZ = (pickup.mesh.userData.localZ as number | undefined) ?? 0;
        const surfaceHeight =
          this.getLocalTrainSurfaceHeight(train.kind, localZ) ?? TRAIN_HEIGHT;

        pickup.mesh.position.set(0, surfaceHeight + 0.55, localZ);
        pickup.mesh.rotation.set(Math.PI / 2, 0, 0);
      }

      pickup.mesh.visible = true;
    });
  }

  private respawnObstacle(obstacle: ObstacleActor): void {
    const positionY = obstacle.kind === "low" ? obstacle.size.y / 2 : 0;

    let attempts = 0;
    let selectedLane = randomLane();
    let candidateZ = this.spawnCursorZ;
    let valid = false;

    while (attempts < 20 && !valid) {
      attempts += 1;
      selectedLane = randomLane();
      candidateZ = this.spawnCursorZ - THREE.MathUtils.randFloat(3.5, 6.5);
      valid = true;

      const laneX = LANE_X[selectedLane];

      // 1. Проверка минимальной дистанции (7.5м) от других препятствий на той же полосе
      for (const other of this.obstacles) {
        if (other === obstacle || !other.mesh.visible) continue;
        if (Math.abs(other.mesh.position.x - laneX) < 0.5) {
          const distanceZ = Math.abs(other.mesh.position.z - candidateZ);
          if (distanceZ < 7.5) {
            valid = false;
            break;
          }
        }
      }

      if (!valid) continue;

      // 2. Исключение спавна препятствий внутри поезда на той же полосе
      for (const train of this.trains) {
        if (!train.root.visible) continue;
        if (Math.abs(train.root.position.x - laneX) < 0.5) {
          const trainFrontZ = train.root.position.z + TRAIN_LENGTH / 2 + 3.5;
          const trainBackZ = train.root.position.z - TRAIN_LENGTH / 2 - 3.5;
          if (candidateZ >= trainBackZ && candidateZ <= trainFrontZ) {
            valid = false;
            break;
          }
        }
      }
    }

    this.spawnCursorZ = Math.min(this.spawnCursorZ, candidateZ);

    obstacle.mesh.position.set(
      LANE_X[selectedLane],
      positionY,
      candidateZ,
    );

    obstacle.mesh.visible = true;
  }

  private respawnPickup(pickup: PickupActor): void {
    if (!pickup.independent) {
      return;
    }

    const lane = randomLane();

    const height = pickup.kind === "coin" ? 1 : 1.15;

    const gap =
      pickup.kind === "coin"
        ? {
            minimum: 2.5,
            maximum: 6,
          }
        : {
            minimum: 12,
            maximum: 22,
          };

    pickup.mesh.position.set(
      LANE_X[lane],
      height,
      this.allocateSpawnZ(gap.minimum, gap.maximum),
    );

    pickup.mesh.visible = true;
  }

  private resetWorldActors(): void {
    this.spawnCursorZ = -12;

    /*
     * Перемешиваем порядок появления поездов,
     * препятствий и бонусов.
     */
    const respawnTasks: Array<() => void> = [
      ...this.trains.map((train) => () => {
        this.respawnTrain(train);
      }),

      ...this.obstacles.map((obstacle) => () => {
        this.respawnObstacle(obstacle);
      }),

      ...this.pickups
        .filter((pickup) => pickup.independent)
        .map((pickup) => () => {
          this.respawnPickup(pickup);
        }),
    ];

    shuffle(respawnTasks);

    respawnTasks.forEach((task) => {
      task();
    });
  }

  /*
   * -----------------------------------------------------
   * КАМЕРА
   * -----------------------------------------------------
   */

  private updateCamera(delta: number): void {
    this.camera.position.x = damp(
      this.camera.position.x,
      this.playerX * 0.3,
      4,
      delta,
    );

    this.camera.position.y = damp(
      this.camera.position.y,
      5.3 + this.playerFeetY * 0.15,
      4,
      delta,
    );

    this.cameraTarget.set(
      this.playerX * 0.18,
      1.3 + this.playerFeetY * 0.2,
      -8,
    );

    this.camera.lookAt(this.cameraTarget);
  }

  /*
   * -----------------------------------------------------
   * СОСТОЯНИЕ ИГРЫ
   * -----------------------------------------------------
   */

  private reset(): void {
    this.input.reset();

    this.currentLane = 1;
    this.playerX = LANE_X[1];

    this.playerFeetY = 0;
    this.verticalVelocity = 0;
    this.grounded = true;

    this.sliding = false;
    this.slideRemaining = 0;

    this.distance = 0;
    this.coins = 0;

    this.shieldActive = false;
    this.magnetRemaining = 0;
    this.hitCooldown = 0;

    this.gameOver = false;

    this.trackTiles.forEach((tile, index) => {
      tile.position.z = 5 - index * TRACK_TILE_LENGTH;
    });

    this.resetWorldActors();
    this.updatePlayerVisual();

    this.clock.start();

    this.previousHudKey = "";
    this.emitHud(true);
  }

  private emitHud(force = false): void {
    const hud: RunnerHud = {
      score: Math.floor(this.distance) + this.coins * 100,

      coins: this.coins,

      shield: this.shieldActive,

      magnetSeconds: Math.ceil(this.magnetRemaining),

      gameOver: this.gameOver,
    };

    const hudKey = JSON.stringify(hud);

    if (!force && hudKey === this.previousHudKey) {
      return;
    }

    this.previousHudKey = hudKey;
    this.onHudChange(hud);
  }

  /*
   * -----------------------------------------------------
   * RESIZE
   * -----------------------------------------------------
   */

  public startGame(): void {
    this.isGameActive = true;
    this.reset();
  }

  public restartGame(): void {
    this.startGame();
  }

  public resetToMenu(): void {
    this.isGameActive = false;
    this.reset();
  }

  private readonly resize = (): void => {
    const width = this.container.clientWidth;

    const height = this.container.clientHeight;

    if (width === 0 || height === 0) {
      return;
    }

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
  };
}
