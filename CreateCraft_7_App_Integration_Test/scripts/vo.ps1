Add-Type -AssemblyName System.Speech
$out = 'E:\ClaudeCraft\CreateCraft_7_App_Integration_Test\SoundCraft\stems'
function Say($text, $file, $voice, $rate) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($voice); $s.Rate = $rate; $s.Volume = 100
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile($file, $fmt); $s.Speak($text); $s.Dispose()
}
Say 'Introducing Volterra X1.' "$out\vo-introducing.wav" 'Microsoft David Desktop' -2
Say 'The future has arrived.' "$out\vo-future.wav" 'Microsoft David Desktop' -3
'ok'
