// edit.js
Page({
  data: {
    loading: true,
    colorPalette: [],
    selectedColor: '',
    selectedColorKey: '',
    pixelData: null,
    gridDimensions: null
  },

  imageInfo: null,

  onReady: function() {
    console.log('编辑页面 Ready');
    this.processImage();
  },

  // 处理图片
  processImage: function() {
    const app = getApp();
    const imageUrl = app.globalData.imagePath;
    const settings = app.globalData.settings;

    console.log('开始处理图片:', imageUrl, settings);

    if (!imageUrl || !settings) {
      wx.showToast({
        title: '缺少图片或设置',
        icon: 'none'
      });
      this.setData({ loading: false });
      return;
    }

    // 生成颜色调色板
    const colorPalette = this.generateColorPalette();
    console.log('生成颜色调色板:', colorPalette);

    // 获取图片信息（宽高）
    wx.getImageInfo({
      src: imageUrl,
      success: (imgRes) => {
        console.log('获取图片信息成功:', imgRes);
        this.imageInfo = imgRes;

        // 计算网格尺寸
        const N = settings.granularity;
        const aspectRatio = imgRes.height / imgRes.width;
        const M = Math.max(1, Math.round(N * aspectRatio));
        console.log('计算网格尺寸:', N, 'x', M, '图片宽高比:', aspectRatio);

        // 延迟执行，确保 Canvas 已渲染
        setTimeout(() => {
          this.processCanvasImage(imageUrl, settings, colorPalette, N, M, aspectRatio);
        }, 200);
      },
      fail: (err) => {
        console.error('获取图片信息失败:', err);
        wx.showToast({
          title: '图片信息获取失败',
          icon: 'none'
        });
        this.setData({ loading: false });
      }
    });
  },

  processCanvasImage: function(imageUrl, settings, colorPalette, N, M, aspectRatio) {
    const canvasWidth = 300;
    const canvasHeight = Math.round(canvasWidth * aspectRatio);

    // 使用旧的 Canvas API 获取 context
    const tempCtx = wx.createCanvasContext('tempCanvas');
    console.log('tempCtx created');

    // 直接绘制图片（微信小程序的 drawImage 可以直接使用临时文件路径）
    tempCtx.drawImage(imageUrl, 0, 0, canvasWidth, canvasHeight);
    tempCtx.draw(false, () => {
      console.log('draw callback called');
      // 获取图片像素数据
      wx.canvasGetImageData({
        canvasId: 'tempCanvas',
        x: 0,
        y: 0,
        width: canvasWidth,
        height: canvasHeight,
        success: (res) => {
          console.log('获取像素数据成功, 数据长度:', res.data.length);
          try {
            // 计算像素网格
            const pixelData = this.calculatePixelGrid(res, canvasWidth, canvasHeight, N, M, colorPalette, settings.mode);
            console.log('生成像素数据完成, 行数:', pixelData.length, '列数:', pixelData[0]?.length);

            // 获取显示 Canvas context 并绘制
            const displayCtx = wx.createCanvasContext('pixelCanvas');
            console.log('displayCtx created');

            // 绘制像素化图像
            this.drawPixelatedImage(displayCtx, pixelData, N, M, canvasWidth, canvasHeight);
            console.log('绘制像素化图像完成');

            // 更新数据
            this.setData({
              loading: false,
              colorPalette: colorPalette.map(function(color) {
                return { key: color.key, color: color.hex };
              }),
              pixelData: pixelData,
              gridDimensions: { N, M }
            });
            console.log('更新数据完成');

            // 保存数据到全局
            const app = getApp();
            app.globalData.pixelData = pixelData;
            app.globalData.gridDimensions = { N, M };
            console.log('保存数据到全局完成');
          } catch (err) {
            console.error('处理像素数据失败:', err);
            wx.showToast({
              title: '图片处理失败',
              icon: 'none'
            });
            this.setData({ loading: false });
          }
        },
        fail: (err) => {
          console.error('获取图片数据失败:', err);
          wx.showToast({
            title: '图片处理失败',
            icon: 'none'
          });
          this.setData({ loading: false });
        }
      });
    });
  },

  // 计算像素网格
  calculatePixelGrid: function(imageData, imgWidth, imgHeight, N, M, palette, mode) {
    const pixelData = [];
    const cellWidth = imgWidth / N;
    const cellHeight = imgHeight / M;

    console.log('开始计算像素网格, 画布尺寸:', imgWidth, 'x', imgHeight, '网格:', N, 'x', M, '单元格尺寸:', cellWidth, 'x', cellHeight);

    for (let i = 0; i < M; i++) {
      const row = [];
      for (let j = 0; j < N; j++) {
        // 计算单元格的边界
        const startX = Math.floor(j * cellWidth);
        const startY = Math.floor(i * cellHeight);
        const endX = Math.min(imgWidth, Math.ceil((j + 1) * cellWidth));
        const endY = Math.min(imgHeight, Math.ceil((i + 1) * cellHeight));

        // 计算单元格的代表色
        const representativeColor = this.calculateCellRepresentativeColor(
          imageData, startX, startY, endX - startX, endY - startY, mode
        );

        // 找到最接近的调色板颜色
        let closestColor;
        if (representativeColor) {
          closestColor = this.findClosestPaletteColor(representativeColor, palette);
        } else {
          // 如果没有有效像素，使用白色
          closestColor = { key: 'H1', hex: '#FFFFFF', rgb: { r: 255, g: 255, b: 255 } };
        }
        row.push({
          key: closestColor.key,
          color: closestColor.hex
        });
      }
      pixelData.push(row);
    }

    return pixelData;
  },

  // 计算单元格的代表色
  calculateCellRepresentativeColor: function(imageData, startX, startY, width, height, mode) {
    const data = imageData.data;
    const imgWidth = imageData.width;
    let rSum = 0, gSum = 0, bSum = 0;
    let pixelCount = 0;
    const colorCounts = {};
    let dominantColor = null;
    let maxCount = 0;

    const endX = startX + width;
    const endY = startY + height;

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        if (y < 0 || y >= imageData.height || x < 0 || x >= imgWidth) continue;

        const index = (Math.floor(y) * imgWidth + Math.floor(x)) * 4;
        if (index < 0 || index + 3 >= data.length) continue;

        // 检查alpha通道，忽略完全透明的像素
        if (data[index + 3] < 128) continue;

        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];

        pixelCount++;

        if (mode === 'average') {
          rSum += r;
          gSum += g;
          bSum += b;
        } else { // dominant mode
          const colorKey = `${r},${g},${b}`;
          colorCounts[colorKey] = (colorCounts[colorKey] || 0) + 1;
          if (colorCounts[colorKey] > maxCount) {
            maxCount = colorCounts[colorKey];
            dominantColor = { r, g, b };
          }
        }
      }
    }

    if (pixelCount === 0) {
      return null;
    }

    if (mode === 'average') {
      return {
        r: Math.round(rSum / pixelCount),
        g: Math.round(gSum / pixelCount),
        b: Math.round(bSum / pixelCount)
      };
    } else {
      return dominantColor || { r: 255, g: 255, b: 255 };
    }
  },

  // 生成颜色调色板
  generateColorPalette: function() {
    return [
      { key: 'A1', hex: '#FF0000', rgb: { r: 255, g: 0, b: 0 } },
      { key: 'B1', hex: '#00FF00', rgb: { r: 0, g: 255, b: 0 } },
      { key: 'C1', hex: '#0000FF', rgb: { r: 0, g: 0, b: 255 } },
      { key: 'D1', hex: '#FFFF00', rgb: { r: 255, g: 255, b: 0 } },
      { key: 'E1', hex: '#FF00FF', rgb: { r: 255, g: 0, b: 255 } },
      { key: 'F1', hex: '#00FFFF', rgb: { r: 0, g: 255, b: 255 } },
      { key: 'G1', hex: '#000000', rgb: { r: 0, g: 0, b: 0 } },
      { key: 'H1', hex: '#FFFFFF', rgb: { r: 255, g: 255, b: 255 } },
      { key: 'I1', hex: '#FFA500', rgb: { r: 255, g: 165, b: 0 } },
      { key: 'J1', hex: '#800080', rgb: { r: 128, g: 0, b: 128 } },
      { key: 'K1', hex: '#008000', rgb: { r: 0, g: 128, b: 0 } },
      { key: 'L1', hex: '#000080', rgb: { r: 0, g: 0, b: 128 } }
    ];
  },

  // 找到最接近的调色板颜色
  findClosestPaletteColor: function(rgb, palette) {
    if (!palette || palette.length === 0) {
      return { key: 'ERR', hex: '#000000', rgb: { r: 0, g: 0, b: 0 } };
    }

    let closestColor = palette[0];
    let minDistance = this.calculateColorDistance(rgb, palette[0].rgb);

    for (let i = 1; i < palette.length; i++) {
      const distance = this.calculateColorDistance(rgb, palette[i].rgb);
      if (distance < minDistance) {
        minDistance = distance;
        closestColor = palette[i];
      }
      if (distance === 0) break;
    }

    return closestColor;
  },

  // 计算颜色距离（欧氏距离）
  calculateColorDistance: function(rgb1, rgb2) {
    const dr = rgb1.r - rgb2.r;
    const dg = rgb1.g - rgb2.g;
    const db = rgb1.b - rgb2.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  },

  // 绘制像素化图像
  drawPixelatedImage: function(canvas, pixelData, N, M, width, height) {
    const cellWidth = width / N;
    const cellHeight = height / M;

    console.log('开始绘制像素化图像, 尺寸:', width, 'x', height, '网格:', N, 'x', M, '单元格:', cellWidth, 'x', cellHeight);

    // 清空画布
    canvas.clearRect(0, 0, width, height);

    // 绘制每个像素
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < N; j++) {
        const pixel = pixelData[i][j];
        if (!pixel) continue;

        const drawX = j * cellWidth;
        const drawY = i * cellHeight;

        // 填充颜色
        canvas.fillStyle = pixel.color;
        canvas.fillRect(drawX, drawY, cellWidth, cellHeight);

        // 绘制边框
        canvas.strokeStyle = '#DDDDDD';
        canvas.lineWidth = 0.5;
        canvas.strokeRect(drawX + 0.5, drawY + 0.5, cellWidth, cellHeight);
      }
    }

    canvas.draw();
  },

  // 选择颜色
  selectColor: function(e) {
    const color = e.currentTarget.dataset.color;
    const key = e.currentTarget.dataset.key;
    this.setData({
      selectedColor: color,
      selectedColorKey: key
    });
  },

  // 点击画布
  onCanvasTap: function(e) {
    if (!this.data.selectedColor || !this.data.pixelData || !this.data.gridDimensions) {
      return;
    }

    const canvasWidth = 300;
    const aspectRatio = this.imageInfo ? this.imageInfo.height / this.imageInfo.width : 0.75;
    const canvasHeight = Math.round(canvasWidth * aspectRatio);
    const { N, M } = this.data.gridDimensions;
    const cellWidth = canvasWidth / N;
    const cellHeight = canvasHeight / M;

    // 计算点击位置对应的单元格
    const x = e.detail.x;
    const y = e.detail.y;
    const col = Math.floor(x / cellWidth);
    const row = Math.floor(y / cellHeight);

    console.log('点击位置:', x, y, '计算行列:', row, col, '网格:', N, M);

    // 检查是否在有效范围内
    if (row >= 0 && row < M && col >= 0 && col < N) {
      // 更新像素数据
      const newPixelData = JSON.parse(JSON.stringify(this.data.pixelData));
      newPixelData[row][col] = {
        key: this.data.selectedColorKey,
        color: this.data.selectedColor
      };

      // 更新数据
      this.setData({
        pixelData: newPixelData
      });

      // 重新绘制
      const canvas = wx.createCanvasContext('pixelCanvas');
      this.drawPixelatedImage(canvas, newPixelData, N, M, canvasWidth, canvasHeight);

      // 更新全局数据
      const app = getApp();
      app.globalData.pixelData = newPixelData;
    }
  },

  // 跳转到下载页面
  navigateToDownload: function() {
    wx.navigateTo({
      url: '/pages/download/download'
    });
  },

  // 返回上一页
  navigateBack: function() {
    wx.navigateBack();
  }
});