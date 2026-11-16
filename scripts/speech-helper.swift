import Foundation
import Speech

let args = Array(CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-") })
let outPath: String? = args.count >= 3 ? args[2] : nil

func emitJSON(_ payload: [String: Any], exitCode: Int32) -> Never {
    let text: String
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let rendered = String(data: data, encoding: .utf8) {
        text = rendered
    } else {
        text = "{\"error\":\"语音识别异常\"}"
    }
    if let outPath {
        try? text.write(toFile: outPath, atomically: true, encoding: .utf8)
    }
    print(text)
    fflush(stdout)
    exit(exitCode)
}

guard args.count >= 1 else {
    emitJSON(["error": "缺少音频文件路径"], exitCode: 2)
}

let wavURL = URL(fileURLWithPath: args[0])
let localeId = args.count >= 2 ? args[1] : "zh-CN"

guard FileManager.default.fileExists(atPath: wavURL.path) else {
    emitJSON(["error": "音频文件不存在"], exitCode: 2)
}

DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 20) {
    emitJSON(["error": "语音识别超时，请重试"], exitCode: 1)
}

SFSpeechRecognizer.requestAuthorization { status in
    switch status {
    case .authorized:
        break
    case .denied, .restricted:
        emitJSON(["error": "请在“系统设置 → 隐私与安全性 → 语音识别”中允许 Agent Pet / 语音识别"], exitCode: 1)
    case .notDetermined:
        emitJSON(["error": "尚未获得系统语音识别权限"], exitCode: 1)
    @unknown default:
        emitJSON(["error": "系统语音识别权限状态未知"], exitCode: 1)
    }

    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) ?? SFSpeechRecognizer()
    guard let recognizer, recognizer.isAvailable else {
        emitJSON(["error": "系统语音识别当前不可用，请检查网络或听写设置"], exitCode: 1)
    }

    let request = SFSpeechURLRecognitionRequest(url: wavURL)
    request.shouldReportPartialResults = false
    if recognizer.supportsOnDeviceRecognition {
        request.requiresOnDeviceRecognition = true
    }

    var settled = false
    recognizer.recognitionTask(with: request) { result, error in
        if settled { return }
        if let result, result.isFinal {
            settled = true
            let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty {
                emitJSON(["error": "没有识别到语音，请再说一遍"], exitCode: 1)
            }
            emitJSON(["text": text], exitCode: 0)
        } else if let error {
            settled = true
            let msg = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            emitJSON(["error": msg.isEmpty ? "没有识别到清晰语音，请重试" : msg], exitCode: 1)
        }
    }
}

dispatchMain()
