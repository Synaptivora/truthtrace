# 素材记录

图片使用 OpenAI 内置 imagegen 工具生成，并保存在项目内。未使用参考截图作为整页背景；页面文字、纸卡、图钉、连线和框架均由 HTML、CSS 与 SVG 实现。

| 文件 | 用途 |
| --- | --- |
| dist/assets/detective-cat.png | 透明背景小侦探插画 |
| dist/assets/inspector-avatar.png | Synapse · 咪探长探头头像与网站图标 |
| dist/assets/campus.jpg | 虚构校园地点示意 |
| dist/assets/students.jpg | 虚构学生背影示意 |
| dist/assets/cork.jpg | 软木板材质 |
| dist/assets/desk-lamp.png | 透明背景黄铜台灯 |
| dist/assets/contacts.jpg | 虚构招募联系人示意 |
| dist/assets/grain.svg | 原生 SVG 纸张与皮革颗粒 |

## 生成提示词

咪探长头像使用内置 imagegen，以原有 detective-cat.png 为角色参考，生成后复制至项目；PNG 保留透明通道。最终提示词：

Create a polished transparent PNG mascot avatar for the top-left logo badge of a warm bronze detective web application. Reference image is character identity reference only. Preserve this exact adorable orange-and-white kitten identity, brown tweed deerstalker detective hat, rich burgundy scarf and brass magnifying glass. New composition: a compact square close-up bust, cat playfully peeking up over a tiny curved dark bronze bottom rim, one fluffy paw resting on the rim and the other paw holding a round brass magnifying glass beside its cheek. Cat looking directly toward viewer, slight curious head tilt. Face and hat occupy most of square so recognizable at 52px, clear expressive golden eyes, ears visible, tasteful detailed plush fur and warm cinematic highlights consistent with reference. Magnifying glass does not obscure both eyes. Simplify coat details to keep icon readable. Entire isolated silhouette has actual alpha transparency, no background, no glow cloud, no shadow backdrop, no text, no letters, no watermark, no decorative external objects. Leave small comfortable transparent margin so ears and glass never touch image edge. Asset type: website mascot logo, square icon.

小侦探：A single adorable cream-and-ginger kitten detective, full body, holding a polished brass magnifying glass. Brown tweed deerstalker hat, tailored camel wool trench coat, burgundy scarf, tactile handmade stop-motion miniature style, warm amber light, transparent background, no text or watermark.

校园：Editorial photograph of a fictional Chinese university campus, pale limestone and warm brick building, symmetrical facade, autumn trees and courtyard, late afternoon golden light, muted analog film colors, no signs, logos or recognizable people.

学生：Candid editorial photograph of three Chinese college students with backpacks, seen from behind, walking through an autumn campus courtyard. No recognizable faces, warm amber light, muted colors, no text or logos.

软木：Straight-on flat scan of fine natural warm caramel cork, rich granular pressed texture, even illumination, seamless repeat, restrained contrast, no objects, marks, pins, text or vignette.

台灯：Antique articulated desk lamp in patinated bronze and aged brass, conical shade pointing down and left, warm glowing bulb, hinged support arm on the right, circular base. Premium realistic metal photography, transparent background, no room, desk, text or watermark.

联系人：Candid editorial photograph of two fictional Chinese adults talking outside a university building, seen from behind and the side, one in brown and one in olive, softly focused faces, muted autumn light, no identifiable real person, no writing or logos.
