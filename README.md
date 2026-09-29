# PUBG 灵敏度诊断工具

独立 Windows 桌面 MVP，用于记录 PUBG 灵敏度、校准鼠标手感、进行 2D 诊断训练，并按“当前设置基准 → 候选方案 → 相同条件复测”比较命中与手感。工具不读取 PUBG 进程、不改写游戏文件。

实战调试默认综合联动，也可选择逐步排查。每组约 5 个弹匣；工具先保存完整参数快照，再根据弹着中心/散布与手感信号给出候选变更表。候选必须由用户手动在 PUBG 中应用。结果相近、测试条件不一致或指标互相牵制时会要求复测，不会宣称唯一最佳值。

## 运行

在项目目录执行：

```powershell
python -m pip install -r requirements.txt
python app.py
```

## 验收

```powershell
python -m unittest -v test_backend.py
python app.py --self-test self_test.json
```

验收覆盖基准门槛、单项/联动候选、倍镜作用范围、垂直增强上限、命中与手感比较、旧数据兼容、会话复制以及 JSON/CSV 导入导出。测试不会访问 PUBG 进程，也不会修改游戏配置。用户数据默认保存在 `%USERPROFILE%\PUBGSensitivityLab`。

## 打包 Windows

```powershell
pyinstaller --noconfirm --clean PUBGSensitivityLab.spec
```

生成文件位于 `dist\PUBGSensitivityLab.exe`。
