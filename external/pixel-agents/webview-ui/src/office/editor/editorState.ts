import type { ColorValue } from '../../components/ui/types.js';
import {
  CARPET_DEFAULT_ACCENT_COLOR,
  CARPET_DEFAULT_COLOR,
  DEFAULT_FLOOR_COLOR,
  DEFAULT_WALL_COLOR,
  UNDO_STACK_MAX_SIZE,
} from '../../constants.js';
import type { OfficeLayout, TileType as TileTypeVal } from '../types.js';
import { EditTool, TileType } from '../types.js';

export class EditorState {
  isEditMode = false;
  activeTool: EditTool = EditTool.SELECT;
  selectedTileType: TileTypeVal = TileType.FLOOR_1;
  selectedFurnitureType = '';

  floorColor: ColorValue = { ...DEFAULT_FLOOR_COLOR };

  wallColor: ColorValue = { ...DEFAULT_WALL_COLOR };

  selectedWallSet = 0;

  wallDragAdding: boolean | null = null;

  pickedFurnitureColor: ColorValue | null = null;

  ghostCol = -1;
  ghostRow = -1;
  ghostValid = false;

  selectedFurnitureUid: string | null = null;

  isDragging = false;

  undoStack: OfficeLayout[] = [];
  redoStack: OfficeLayout[] = [];

  isDirty = false;

  dragUid: string | null = null;
  dragStartCol = 0;
  dragStartRow = 0;
  dragOffsetCol = 0;
  dragOffsetRow = 0;
  isDragMoving = false;

  carpetVariant = 0;
  carpetColor: ColorValue = { ...CARPET_DEFAULT_COLOR };
  carpetAccentColor: ColorValue = { ...CARPET_DEFAULT_ACCENT_COLOR };
  carpetDragErasing: boolean | null = null;
  carpetStrokeInitialLayout: OfficeLayout | null = null;

  selectedAreaLabel: string | null = null;
  areaDragErasing: boolean | null = null;

  pushUndo(layout: OfficeLayout): void {
    this.undoStack.push(layout);
    if (this.undoStack.length > UNDO_STACK_MAX_SIZE) {
      this.undoStack.shift();
    }
  }

  popUndo(): OfficeLayout | null {
    return this.undoStack.pop() || null;
  }

  pushRedo(layout: OfficeLayout): void {
    this.redoStack.push(layout);
    if (this.redoStack.length > UNDO_STACK_MAX_SIZE) {
      this.redoStack.shift();
    }
  }

  popRedo(): OfficeLayout | null {
    return this.redoStack.pop() || null;
  }

  clearRedo(): void {
    this.redoStack = [];
  }

  clearSelection(): void {
    this.selectedFurnitureUid = null;
  }

  clearGhost(): void {
    this.ghostCol = -1;
    this.ghostRow = -1;
    this.ghostValid = false;
  }

  startDrag(
    uid: string,
    startCol: number,
    startRow: number,
    offsetCol: number,
    offsetRow: number,
  ): void {
    this.dragUid = uid;
    this.dragStartCol = startCol;
    this.dragStartRow = startRow;
    this.dragOffsetCol = offsetCol;
    this.dragOffsetRow = offsetRow;
    this.isDragMoving = false;
  }

  clearDrag(): void {
    this.dragUid = null;
    this.isDragMoving = false;
  }

  reset(): void {
    this.activeTool = EditTool.SELECT;
    this.selectedFurnitureUid = null;
    this.ghostCol = -1;
    this.ghostRow = -1;
    this.ghostValid = false;
    this.isDragging = false;
    this.wallDragAdding = null;
    this.undoStack = [];
    this.redoStack = [];
    this.isDirty = false;
    this.dragUid = null;
    this.isDragMoving = false;
    this.carpetVariant = 0;
    this.carpetColor = { ...CARPET_DEFAULT_COLOR };
    this.carpetAccentColor = { ...CARPET_DEFAULT_ACCENT_COLOR };
    this.carpetDragErasing = null;
    this.carpetStrokeInitialLayout = null;
    this.selectedAreaLabel = null;
    this.areaDragErasing = null;
  }
}
