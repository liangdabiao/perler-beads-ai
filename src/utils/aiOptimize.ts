// AI图片优化工具函数

import { callVolcEngineAI } from '@/lib/volcEngineClient';

const DEFAULT_PROMPT = '图片修改为：chibi画风，背景白底。pixel art style, 16-bit, retro game aesthetic, sharp focus, high contrast, clean lines, detailed pixel art, masterpiece, best quality';

const VOLC_ACCESS_KEY_ID = process.env.NEXT_PUBLIC_VOLC_ACCESS_KEY_ID;
const VOLC_SECRET_ACCESS_KEY = process.env.NEXT_PUBLIC_VOLC_SECRET_ACCESS_KEY;
const IS_STATIC_DEPLOYMENT = process.env.NEXT_PUBLIC_IS_STATIC_DEPLOYMENT === 'true';

export interface AIOptimizeOptions {
  customPrompt?: string;
  onProgress?: (progress: number) => void;
}

export interface AIOptimizeResult {
  success: boolean;
  imageUrl?: string;
  error?: string;
}

/**
 * 压缩图片到指定尺寸
 */
function resizeImage(img: HTMLImageElement, maxWidth: number = 2048, maxHeight: number = 2048): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  let width = img.width;
  let height = img.height;

  // 计算缩放比例
  if (width > maxWidth || height > maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height);
    width = Math.floor(width * ratio);
    height = Math.floor(height * ratio);
  }

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // 使用更好的图像质量
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  return canvas;
}

/**
 * 将Canvas转换为Base64格式，控制文件大小
 */
function canvasToBase64(canvas: HTMLCanvasElement, maxSizeKB: number = 4096): string {
  // 首先尝试PNG格式（无损）
  let base64 = canvas.toDataURL('image/png');
  let sizeKB = Math.round((base64.length * 3) / 4 / 1024);

  console.log('Original image size:', sizeKB, 'KB');

  // 如果PNG太大，尝试JPEG格式并调整质量
  if (sizeKB > maxSizeKB) {
    let quality = 0.9;
    while (sizeKB > maxSizeKB && quality > 0.3) {
      base64 = canvas.toDataURL('image/jpeg', quality);
      sizeKB = Math.round((base64.length * 3) / 4 / 1024);
      console.log(`JPEG quality ${quality}:`, sizeKB, 'KB');
      quality -= 0.1;
    }
  }

  // 如果还是太大，缩小尺寸
  if (sizeKB > maxSizeKB) {
    const scale = Math.sqrt(maxSizeKB / sizeKB) * 0.9;
    const newWidth = Math.floor(canvas.width * scale);
    const newHeight = Math.floor(canvas.height * scale);

    console.log(`Resizing to ${newWidth}x${newHeight}`);

    const newCanvas = document.createElement('canvas');
    newCanvas.width = newWidth;
    newCanvas.height = newHeight;
    const newCtx = newCanvas.getContext('2d');

    if (!newCtx) {
      throw new Error('Failed to get canvas context');
    }

    newCtx.imageSmoothingEnabled = true;
    newCtx.imageSmoothingQuality = 'high';
    newCtx.drawImage(canvas, 0, 0, newWidth, newHeight);

    return canvasToBase64(newCanvas, maxSizeKB);
  }

  console.log('Final image size:', sizeKB, 'KB');
  return base64;
}

/**
 * 将图片转换为Base64格式
 */
export function imageToBase64(imageSrc: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        console.log('Original image size:', img.width, 'x', img.height);

        // 压缩图片
        const canvas = resizeImage(img, 2048, 2048);

        // 转换为base64，控制大小在4MB以内
        const base64 = canvasToBase64(canvas, 4096);

        resolve(base64);
      } catch (error) {
        reject(error);
      }
    };

    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };

    img.src = imageSrc;
  });
}

/**
 * 调用AI优化API
 */
export async function optimizeImageWithAI(
  imageSrc: string,
  options: AIOptimizeOptions = {}
): Promise<AIOptimizeResult> {
  try {
    const { customPrompt, onProgress } = options;

    onProgress?.(10);

    const base64Image = await imageToBase64(imageSrc);

    onProgress?.(30);

    if (IS_STATIC_DEPLOYMENT && VOLC_ACCESS_KEY_ID && VOLC_SECRET_ACCESS_KEY) {
      const result = await callVolcEngineAI(
        base64Image,
        customPrompt || DEFAULT_PROMPT,
        VOLC_ACCESS_KEY_ID,
        VOLC_SECRET_ACCESS_KEY,
        onProgress
      );

      if (result.success && result.imageUrl) {
        return {
          success: true,
          imageUrl: result.imageUrl
        };
      } else {
        throw new Error(result.error || 'Unknown error');
      }
    }

    const response = await fetch('/api/ai-optimize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        imageBase64: base64Image,
        prompt: customPrompt || DEFAULT_PROMPT
      })
    });

    onProgress?.(80);

    if (!response.ok) {
      let errorMessage: string;
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || `API request failed: ${response.status}`;
      } catch {
        const errorText = await response.text();
        errorMessage = errorText || `API request failed: ${response.status}`;
      }
      throw new Error(errorMessage);
    }

    const result = await response.json();

    onProgress?.(100);

    if (result.success && result.imageUrl) {
      return {
        success: true,
        imageUrl: result.imageUrl
      };
    } else {
      throw new Error(result.error || 'Unknown error');
    }

  } catch (error) {
    console.error('AI optimization error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'AI optimization failed'
    };
  }
}

/**
 * 下载远程图片并转换为DataURL
 */
export async function downloadImageAsDataURL(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl);
  const blob = await response.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to convert image to data URL'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
