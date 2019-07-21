let url;
let term;
let ws;
let connected = false;
let binary_state = 0;
let put_file_name = null;
let put_file_data = null;
let get_file_name = null;
let get_file_data = null;

let timer = null;

function calculate_size(win) { // 현재 윈도우 크기를 측정
    let cols = document.getElementById("consoleOutputBox").offsetWidth/6.7|0;
    let rows = document.getElementById("consoleOutputBox").offsetHeight/13|0;
    return [cols, rows];
}

(function() {
    window.onload = function() { // load 시,
        url = window.location.hash.substring(1); // 웹소켓 통신 url을 가져옴
        if (url)
            url = 'ws://' + url;
        else
            url = "ws://192.168.4.1:8266/";
        let size = calculate_size(self);
        term = new Terminal({ // 터미널 생성
            cols: size[0],
            rows: size[1],
            useStyle: true,
            screenKeys: true,
            cursorBlink: false
        });
        term.open(document.getElementById("consoleOutputBox"));
        show_https_warning();
    };
    window.addEventListener('resize', function() { // 크기 재조정 시,
        let size = calculate_size(self);
        term.resize(size[0], size[1]);
    });
}).call(this);

function show_https_warning() { // https 접속 시 경고
    if (window.location.protocol == 'https:') {
        let warningDiv = document.createElement('div');
        warningDiv.style.cssText = 'background:#f99;padding:5px;margin-bottom:10px;line-height:1.5em;text-align:center';
        warningDiv.innerHTML = [
            'At this time, the WebREPL client cannot be accessed over HTTPS connections.',
            'Use a HTTP connection, eg. <a href="http://micropython.org/webrepl/">http://micropython.org/webrepl/</a>.',
            'Alternatively, download the files from <a href="https://github.com/micropython/webrepl">GitHub</a> and run them locally.'
        ].join('<br>');
        document.body.insertBefore(warningDiv, document.body.childNodes[0]);
        term.resize(term.cols, term.rows - 7);
    }
}

function prepare_for_connect() { // 다음 연결을 위한 준비 작업 함수
    document.getElementById('connectBtn').value = "Connect";
}

function update_file_status(s) { // 현재 상태 표현 함수
    if(timer !== null){
        clearTimeout(timer);
    }
    document.getElementById("updateStatusModal").style.display = "block";
    document.getElementById('statOutput').innerText = s;
    timer = setTimeout(function() {document.getElementById("updateStatusModal").style.display = "none";}, 1000);
}

function connect(url) {
    window.location.hash = url.substring(5);
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function() {
        term.removeAllListeners('data');
        term.on('data', function(data) {
            // Pasted data from clipboard will likely contain
            // LF as EOL chars.
            data = data.replace(/\n/g, "\r");
            ws.send(data);
        });

        term.on('title', function(title) {
            document.title = title;
        });

        term.focus();
        term.element.focus();
        term.write('\x1b[31mWelcome to MicroPython!\x1b[m\r\n');

        ws.onmessage = function(event) {
            if (event.data instanceof ArrayBuffer) {
                let data = new Uint8Array(event.data);
                switch (binary_state) {
                    case 11:
                        // first response for put
                        if (decode_resp(data) == 0) {
                            // send file data in chunks
                            for (let offset = 0; offset < put_file_data.length; offset += 1024) {
                                ws.send(put_file_data.slice(offset, offset + 1024));
                            }
                            binary_state = 12;
                        }
                        break;
                    case 12:
                        // final response for put
                        if (decode_resp(data) == 0) {
                            update_file_status('Sent ' + put_file_name + ', ' + put_file_data.length + ' bytes');
                        } else {
                            update_file_status('Failed sending ' + put_file_name);
                        }
                        binary_state = 0;
                        break;

                    case 21:
                        // first response for get
                        if (decode_resp(data) == 0) {
                            binary_state = 22;
                            let rec = new Uint8Array(1);
                            rec[0] = 0;
                            ws.send(rec);
                        }
                        break;
                    case 22: {
                        // file data
                        let sz = data[0] | (data[1] << 8);
                        if (data.length == 2 + sz) {
                            // we assume that the data comes in single chunks
                            if (sz == 0) {
                                // end of file
                                binary_state = 23;
                            } else {
                                // accumulate incoming data to get_file_data
                                let new_buf = new Uint8Array(get_file_data.length + sz);
                                new_buf.set(get_file_data);
                                new_buf.set(data.slice(2), get_file_data.length);
                                get_file_data = new_buf;
                                update_file_status('Getting ' + get_file_name + ', ' + get_file_data.length + ' bytes');

                                let rec = new Uint8Array(1);
                                rec[0] = 0;
                                ws.send(rec);
                            }
                        } else {
                            binary_state = 0;
                        }
                        break;
                    }
                    case 23:
                        // final response
                        if (decode_resp(data) == 0) {
                            update_file_status('Got ' + get_file_name + ', ' + get_file_data.length + ' bytes');
                            saveAs(new Blob([get_file_data], {type: "application/octet-stream"}), get_file_name);
                        } else {
                            update_file_status('Failed getting ' + get_file_name);
                        }
                        binary_state = 0;
                        break;
                    case 31:
                        // first (and last) response for GET_VER
                        console.log('GET_VER', data);
                        binary_state = 0;
                        break;
                    case 41:

                }
            }
            term.write(event.data);
        };
    };

    ws.onclose = function() {
        connected = false;
        if (term) {
            term.write('\x1b[31mDisconnected\x1b[m\r\n');
        }
        term.off('data');
        prepare_for_connect();
    }
}

function decode_resp(data) {
    if (data[0] == 'W'.charCodeAt(0) && data[1] == 'B'.charCodeAt(0)) {
        let code = data[2] | (data[3] << 8);
        return code;
    } else {
        return -1;
    }
}

function put_file() {
    let dest_fname = put_file_name;
    let dest_fsize = put_file_data.length;

    // WEBREPL_FILE = "<2sBBQLH64s"
    let rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
    rec[0] = 'W'.charCodeAt(0);
    rec[1] = 'A'.charCodeAt(0);
    rec[2] = 1; // put
    rec[3] = 0;
    rec[4] = 0; rec[5] = 0; rec[6] = 0; rec[7] = 0; rec[8] = 0; rec[9] = 0; rec[10] = 0; rec[11] = 0;
    rec[12] = dest_fsize & 0xff; rec[13] = (dest_fsize >> 8) & 0xff; rec[14] = (dest_fsize >> 16) & 0xff; rec[15] = (dest_fsize >> 24) & 0xff;
    rec[16] = dest_fname.length & 0xff; rec[17] = (dest_fname.length >> 8) & 0xff;
    for (let i = 0; i < 64; ++i) {
        if (i < dest_fname.length) {
            rec[18 + i] = dest_fname.charCodeAt(i);
        } else {
            rec[18 + i] = 0;
        }
    }

    // initiate put
    binary_state = 11;
    update_file_status('Sending ' + put_file_name + '...');
    ws.send(rec);
}

function get_file(input_fname) {
    //let src_fname = document.getElementById('get_filename').value;
    let src_fname = input_fname;

    // WEBREPL_FILE = "<2sBBQLH64s"
    let rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
    rec[0] = 'W'.charCodeAt(0);
    rec[1] = 'A'.charCodeAt(0);
    rec[2] = 2; // get
    rec[3] = 0;
    rec[4] = 0; rec[5] = 0; rec[6] = 0; rec[7] = 0; rec[8] = 0; rec[9] = 0; rec[10] = 0; rec[11] = 0;
    rec[12] = 0; rec[13] = 0; rec[14] = 0; rec[15] = 0;
    rec[16] = src_fname.length & 0xff; rec[17] = (src_fname.length >> 8) & 0xff;
    for (let i = 0; i < 64; ++i) {
        if (i < src_fname.length) {
            rec[18 + i] = src_fname.charCodeAt(i);
        } else {
            rec[18 + i] = 0;
        }
    }

    // initiate get
    binary_state = 21;
    get_file_name = src_fname;
    get_file_data = new Uint8Array(0);
    update_file_status('Getting ' + get_file_name + '...');
    ws.send(rec);
}

function get_ver() {
    // WEBREPL_REQ_S = "<2sBBQLH64s"
    let rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
    rec[0] = 'W'.charCodeAt(0);
    rec[1] = 'A'.charCodeAt(0);
    rec[2] = 3; // GET_VER
    // rest of "rec" is zero

    // initiate GET_VER
    binary_state = 31;
    ws.send(rec);
}

// 기기와 연결시키는 함수
function connectDevice(){
    if (connected) {
        ws.close();
    } else {
        url = prompt('웹소켓 주소 : ', url);
        if(url !== null) {
            document.getElementById('connectBtn').value = "Disconnect";
            connected = true;
            connect(url);
        }
    }
}

// test.py를 기기에서 실행시키는 함수
function runDevice(){
    if(connected){
        term.send("import disk; disk.run(\"test.py\")\n");
    }
    else
        alert("기기를 연결해주세요.");
}

// python 코드를 실행중인 기기를 멈추는 함수
function stopDevice(){
    if(connected){
        term.send("\x03");
        setTimeout(function (){term.send("import boot; turnoff_pins()\n")}, 1);
    }
    else
        alert("기기를 연결해주세요.");
}

// 기기에 python code를 upload 하는 함수
function uploadDevice(){
    if(connected){
        let upload_name = prompt('업로드할 파일 이름 : ', 'test.py');
        if(upload_name === "")
            alert("업로드할 파일 이름을 입력해주세요.");
        else if (upload_name !== "" && upload_name !== null) {
            let upload_name_split = upload_name.split(".");
            if (!(upload_name_split.length > 1))
                upload_name += ".py";

            let upload_data = document.getElementById("codeWriteBox").value;
            if(upload_data.charAt(upload_data.length - 1) !== "\n")
                upload_data += "\n";
            let f = new File([new Blob([upload_data])], upload_name);

            put_file_name = f.name;
            let reader = new FileReader();
            reader.onload = function(e) {
                put_file_data = new Uint8Array(e.target.result);
                put_file();
            };
            reader.readAsArrayBuffer(f);
        }
    }
    else
        alert("기기를 연결해주세요.");
}

function downloadDevice() {
    if(connected){
        let download_name = prompt('다운로드할 파일 이름 : ', 'test.py');
        if(download_name === "")
            alert("다운로드할 파일 이름을 입력해주세요.");
        else if (download_name !== "" && download_name !== null) {
            let download_name_split = download_name .split(".");
            if (!(download_name_split.length > 1))
                download_name  += ".py";

            get_file(download_name);
        }
    }
    else
        alert("기기를 연결해주세요.");
}

// 선택된 파일을 읽는 함수
function fileReader(){
    let file = document.getElementById("fileSelector").files[0];
    let reader = new FileReader();
    reader.readAsText(file, "utf-8");

    reader.onload = function() // reader가 load 되었을 경우, 처리
    {
        let view = document.getElementById("codeWriteBox");
        view.value = reader.result;
    };
    reader.onerror = function(event) // 오류 시, 처리
    {
        switch(event.target.error.code)
        {
            case error.NOT_FOUND_ERR: alert("파일이 없음"); break;
            case error.SECURITY_ERR: alert("보안규칙 위반"); break;
            case error.ABORT_ERR: alert("읽기 중지"); break;
            case error.NOT_READABLE_ERR: alert("권한 없음"); break;
            case error.ENCODING_ERR: alert("용량 초과"); break;
        }
    };
}

// python code를 download 하는 함수
function fileDownloader(){
    let fileName = prompt('저장할 파일 이름 : ');
    if(fileName === "")
        alert("저장할 파일 이름을 입력해주세요.");
    else if (fileName !== "" && fileName !== null){
        let blob = new Blob([document.getElementById("codeWriteBox").value], {type: "application/octet-stream"});

        let fileNameSplit = fileName.split(".");
        if(fileNameSplit.length > 1)
            saveAs(blob, fileName);
        else
            saveAs(blob, fileName + ".py");
    }
}

/* modal 설정 함수 모음 */
function supportPopup(){
    document.getElementById("supportModal").style.display = "block";
}

function closeSupport(){
    document.getElementById("supportModal").style.display = "none";
}

window.onclick = function (event) {
    if (event.target === document.getElementById("supportModal")) {
        closeSupport();
    }
};

// textarea tab 적용
function applyTap(event) {
    if (event.keyCode === 9) {
        event.preventDefault();
        let v = event.target.value, s = event.target.selectionStart, e = event.target.selectionEnd;
        event.target.value = v.substring(0, s) + '\t' + v.substring(e);
        event.target.selectionStart = event.target.selectionEnd = s + 1;
    }
}