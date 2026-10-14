//! omp RPC transport: per-line frame heads and strict v2 `rpc_chunk` reassembly.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::value::RawValue;

/// Default `maxReassembledFrameBytes` advertised by omp's `ready` frame.
pub const MAX_REASSEMBLED: usize = 64 * 1024 * 1024;

/// The few fields the host routes on. Everything else is forwarded verbatim.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    #[serde(rename = "type", default)]
    pub kind: String,
    pub id: Option<String>,
    pub method: Option<String>,
    pub target_id: Option<String>,
    pub status_key: Option<String>,
    pub status_text: Option<String>,
    pub widget_key: Option<String>,
    pub widget_lines: Option<Vec<String>>,
    pub is_terminal: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    chunk_id: String,
    index: usize,
    count: usize,
    byte_length: usize,
    data: String,
}

struct Partial {
    chunk_id: String,
    count: usize,
    byte_length: usize,
    next: usize,
    buf: Vec<u8>,
}

pub enum Step {
    Pending,
    Frame(Box<RawValue>),
}

pub struct Reassembler {
    max: usize,
    cur: Option<Partial>,
}

impl Reassembler {
    pub fn new(max: usize) -> Self {
        Self { max, cur: None }
    }

    /// An ordinary frame arrived. Errors if it interrupted a chunk sequence.
    pub fn interrupt(&mut self) -> Result<(), String> {
        match self.cur.take() {
            Some(p) => Err(format!("chunk sequence {} interrupted by an ordinary frame", p.chunk_id)),
            None => Ok(()),
        }
    }

    /// Feed one `rpc_chunk` line. Any violation drops the sequence.
    pub fn push(&mut self, line: &[u8]) -> Result<Step, String> {
        let res = self.push_inner(line);
        if res.is_err() {
            self.cur = None;
        }
        res
    }

    fn push_inner(&mut self, line: &[u8]) -> Result<Step, String> {
        let c: Chunk = serde_json::from_slice(line).map_err(|e| format!("bad rpc_chunk: {e}"))?;
        if c.chunk_id.is_empty() {
            return Err("rpc_chunk has an empty chunkId".into());
        }
        let p = match self.cur.as_mut() {
            None => {
                if c.index != 0 {
                    return Err(format!("chunk sequence {} starts at index {}", c.chunk_id, c.index));
                }
                if c.count == 0 || c.byte_length > self.max {
                    return Err(format!("chunk sequence {} has invalid count or byteLength", c.chunk_id));
                }
                self.cur.insert(Partial {
                    chunk_id: c.chunk_id.clone(),
                    count: c.count,
                    byte_length: c.byte_length,
                    next: 0,
                    buf: Vec::with_capacity(c.byte_length),
                })
            }
            Some(p) => p,
        };
        if c.chunk_id != p.chunk_id || c.count != p.count || c.byte_length != p.byte_length {
            return Err(format!("chunk sequence {} changed chunkId, count or byteLength", p.chunk_id));
        }
        if c.index != p.next {
            return Err(format!("chunk sequence {} expected index {}, got {}", p.chunk_id, p.next, c.index));
        }
        STANDARD
            .decode_vec(c.data.as_bytes(), &mut p.buf)
            .map_err(|e| format!("chunk sequence {}: bad base64: {e}", p.chunk_id))?;
        if p.buf.len() > p.byte_length {
            return Err(format!("chunk sequence {} exceeds its byteLength", p.chunk_id));
        }
        p.next += 1;
        if p.next < p.count {
            return Ok(Step::Pending);
        }
        let p = self.cur.take().expect("partial present");
        if p.buf.len() != p.byte_length {
            return Err(format!("chunk sequence {} is {} bytes, expected {}", p.chunk_id, p.buf.len(), p.byte_length));
        }
        let text = String::from_utf8(p.buf).map_err(|_| format!("chunk sequence {} is not UTF-8", p.chunk_id))?;
        if !text.trim_start().starts_with('{') {
            return Err(format!("chunk sequence {} is not a JSON object", p.chunk_id));
        }
        let raw = RawValue::from_string(text).map_err(|e| format!("chunk sequence {} is not JSON: {e}", p.chunk_id))?;
        Ok(Step::Frame(raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunks(id: &str, payload: &[u8], parts: usize) -> Vec<String> {
        let size = payload.len().div_ceil(parts);
        payload
            .chunks(size)
            .enumerate()
            .map(|(i, part)| {
                serde_json::json!({
                    "type": "rpc_chunk", "chunkId": id, "index": i, "count": parts,
                    "byteLength": payload.len(), "data": STANDARD.encode(part),
                })
                .to_string()
            })
            .collect()
    }

    fn feed(r: &mut Reassembler, lines: &[String]) -> Result<Option<String>, String> {
        let mut out = None;
        for l in lines {
            if let Step::Frame(raw) = r.push(l.as_bytes())? {
                out = Some(raw.get().to_string());
            }
        }
        Ok(out)
    }

    #[test]
    fn reassembles_in_order() {
        let payload = br#"{"type":"response","id":"m","data":{"models":[1,2,3]}}"#;
        let mut r = Reassembler::new(MAX_REASSEMBLED);
        assert_eq!(feed(&mut r, &chunks("c1", payload, 3)).unwrap().unwrap().as_bytes(), payload);
        assert!(r.interrupt().is_ok(), "sequence must be finished");
    }

    #[test]
    fn rejects_gap() {
        let mut lines = chunks("c1", br#"{"a":"0123456789"}"#, 3);
        lines.remove(1);
        assert!(feed(&mut Reassembler::new(MAX_REASSEMBLED), &lines).is_err());
    }

    #[test]
    fn rejects_changed_fields() {
        let mut lines = chunks("c1", br#"{"a":"0123456789"}"#, 2);
        lines[1] = lines[1].replace("\"c1\"", "\"c2\"");
        assert!(feed(&mut Reassembler::new(MAX_REASSEMBLED), &lines).is_err());
    }

    #[test]
    fn rejects_interruption() {
        let lines = chunks("c1", br#"{"a":"0123456789"}"#, 2);
        let mut r = Reassembler::new(MAX_REASSEMBLED);
        assert!(matches!(r.push(lines[0].as_bytes()), Ok(Step::Pending)));
        assert!(r.interrupt().is_err());
        assert!(r.push(lines[1].as_bytes()).is_err(), "tail of an interrupted sequence is rejected");
    }

    #[test]
    fn rejects_oversize_and_bad_payloads() {
        assert!(feed(&mut Reassembler::new(8), &chunks("c1", br#"{"a":"0123456789"}"#, 2)).is_err());
        assert!(feed(&mut Reassembler::new(MAX_REASSEMBLED), &chunks("c1", &[0x7b, 0xff, 0xfe, 0x7d], 2)).is_err());
        assert!(feed(&mut Reassembler::new(MAX_REASSEMBLED), &chunks("c1", b"[1,2,3]", 1)).is_err());
        assert!(feed(&mut Reassembler::new(MAX_REASSEMBLED), &chunks("", br#"{"a":1}"#, 1)).is_err());
    }

    #[test]
    fn recovers_after_error() {
        let mut r = Reassembler::new(MAX_REASSEMBLED);
        let mut bad = chunks("c1", br#"{"a":"0123456789"}"#, 2);
        bad[1] = bad[1].replace("\"index\":1", "\"index\":5");
        assert!(feed(&mut r, &bad).is_err());
        assert!(feed(&mut r, &chunks("c2", br#"{"b":2}"#, 1)).unwrap().is_some());
    }
}
