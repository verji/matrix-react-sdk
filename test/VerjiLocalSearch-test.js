//ROSBERG
import {
  findAllMatches,
  eventMatchesSearchTerms,
  makeSearchTermObject,
  isMemberMatch
} from '../src/VerjiLocalSearch';


describe("LocalSearch", () => {
    it("should return true for matches", async (done) => {
      let testEvent = {};
      testEvent.getType = () => { return "m.room.message" };
      testEvent.isRedacted = () => { return false; };
      testEvent.getContent = () => { return { body: "bodytext" } };
      testEvent.getSender = () => { return { userId: "testtestsson" } };
      testEvent.getDate = () => { return new Date(); };

      let termObj = {
  	  	searchTypeAdvanced: false,
		    searchTypeNormal: true,
  		  fullText: "bodytext",
	  	  words: [{ word: "bodytext", highlight: false }],
        regExpHighlights: []
      };

      let isMatch = eventMatchesSearchTerms(termObj, testEvent, []);
      expect(isMatch).toBe(true);
      done();
    });

    it("finds only one match among several", async (done) => {
      let testEvent = {};
      testEvent.getType = () => { return "m.room.message" };
      testEvent.isRedacted = () => { return false; };
      testEvent.getContent = () => { return { body: "bodytext" } };
      testEvent.getSender = () => { return { userId: "testtestsson" } };
      testEvent.getDate = () => { return new Date(); };

      let testEvent2 = {};
      testEvent2.getType = () => { return "m.room.message" };
      testEvent2.isRedacted = () => { return false; };
      testEvent2.getContent = () => { return { body: "not that text at all" } };
      testEvent2.getSender = () => { return { userId: "testtestsson" } };
      testEvent2.getDate = () => { return new Date(); };

      let testEvent3 = {};
      testEvent3.getType = () => { return "m.room.message" };
      testEvent3.isRedacted = () => { return false; };
      testEvent3.getContent = () => { return { body: "some different text that doesn't match" } };
      testEvent3.getSender = () => { return { userId: "testtestsson" } };
      testEvent3.getDate = () => { return new Date(); };

      let room = {};
      room.getLiveTimeline = () => {
          let timeline = {};
          timeline.getEvents = () => { return [testEvent, testEvent2, testEvent3]; };
          timeline.getNeighbouringTimeline = (direction) => {
            return null;
          };
          return timeline;
      };
      room.currentState = {
        getMembers: () => { return [{ name: "Name Namesson", userId: "testtestsson" }];}
      };

      let termObj = {
  	  	searchTypeAdvanced: false,
		    searchTypeNormal: true,
  		  fullText: "bodytext",
	  	  words: [{ word: "bodytext", highlight: false }],
        regExpHighlights: []
      };

      let matches = await findAllMatches(termObj, room, []);
      expect(matches.length).toBe(1);
      done();
    });

    it("finds several different with advanced search", async (done) => {
      let testEvent = {};
      testEvent.getType = () => { return "m.room.message" };
      testEvent.isRedacted = () => { return false; };
      testEvent.getContent = () => { return { body: "body text" } };
      testEvent.getSender = () => { return { userId: "testtestsson" } };
      testEvent.getDate = () => { return new Date(); };

      let testEvent2 = {};
      testEvent2.getType = () => { return "m.room.message" };
      testEvent2.isRedacted = () => { return false; };
      testEvent2.getContent = () => { return { body: "not that text at all" } };
      testEvent2.getSender = () => { return { userId: "testtestsson" } };
      testEvent2.getDate = () => { return new Date(); };

      let testEvent3 = {};
      testEvent3.getType = () => { return "m.room.message" };
      testEvent3.isRedacted = () => { return false; };
      testEvent3.getContent = () => { return { body: "some different text that doesn't match" } };
      testEvent3.getSender = () => { return { userId: "testtestsson" } };
      testEvent3.getDate = () => { return new Date(); };

      let testEvent4 = {};
      testEvent4.getType = () => { return "m.room.message" };
      testEvent4.isRedacted = () => { return false; };
      testEvent4.getContent = () => { return { body: "a text that isn't found" } };
      testEvent4.getSender = () => { return { userId: "testtestsson" } };
      testEvent4.getDate = () => { return new Date(); };

      let room = {};
      room.getLiveTimeline = () => {
          let timeline = {};
          timeline.getEvents = () => { return [testEvent, testEvent2, testEvent3, testEvent4]; };
          timeline.getNeighbouringTimeline = (direction) => {
            return null;
          };
          return timeline;
      };

      let termObj = makeSearchTermObject("rx:(body|all|some)");
      expect(termObj.searchTypeAdvanced).toBe(true);

      let matches = await findAllMatches(termObj, room, []);
      expect(matches.length).toBe(3);
      done();
    });

    it("should be able to find messages sent by specific members", async (done) => {
      let testEvent = {};
      testEvent.getType = () => { return "m.room.message" };
      testEvent.isRedacted = () => { return false; };
      testEvent.getContent = () => { return { body: "body text" } };
      testEvent.getSender = () => { return { userId: "testtestsson" } };
      testEvent.getDate = () => { return new Date(); };

      let testEvent2 = {};
      testEvent2.getType = () => { return "m.room.message" };
      testEvent2.isRedacted = () => { return false; };
      testEvent2.getContent = () => { return { body: "not that text at all" } };
      testEvent2.getSender = () => { return { userId: "namersson" } };
      testEvent2.getDate = () => { return new Date(); };

      let testEvent3 = {};
      testEvent3.getType = () => { return "m.room.message" };
      testEvent3.isRedacted = () => { return false; };
      testEvent3.getContent = () => { return { body: "some different text, but not the one" } };
      testEvent3.getSender = () => { return { userId: "namersson" } };
      testEvent3.getDate = () => { return new Date(); };

      let testEvent4 = {};
      testEvent4.getType = () => { return "m.room.message" };
      testEvent4.isRedacted = () => { return false; };
      testEvent4.getContent = () => { return { body: "a text" } };
      testEvent4.getSender = () => { return { userId: "testtestsson" } };
      testEvent4.getDate = () => { return new Date(); };

      let room = {};
      room.getLiveTimeline = () => {
          let timeline = {};
          timeline.getEvents = () => { return [testEvent, testEvent2, testEvent3, testEvent4]; };
          timeline.getNeighbouringTimeline = (direction) => {
            return null;
          };
          return timeline;
      };

      let foundUsers = {};
      foundUsers["testtestsson"] = { name: "Test Testsson", userId: "testtestsson" };
      let termObj = makeSearchTermObject("Testsson");
      let matches = await findAllMatches(termObj, room, foundUsers);
      expect(matches.length).toBe(2);
      expect(matches[0].result.getSender().userId).toBe("testtestsson");
      expect(matches[1].result.getSender().userId).toBe("testtestsson");
      done();
    });

    it("can find by ISO date", async (done) => {
      let testEvent = {};
      testEvent.getType = () => { return "m.room.message" };
      testEvent.isRedacted = () => { return false; };
      testEvent.getContent = () => { return { body: "body text" } };
      testEvent.getSender = () => { return { userId: "testtestsson" } };
      testEvent.getDate = () => { return new Date(2020, 10, 2, 13, 30, 0); };

      let testEvent2 = {};
      testEvent2.getType = () => { return "m.room.message" };
      testEvent2.isRedacted = () => { return false; };
      testEvent2.getContent = () => { return { body: "not that text at all" } };
      testEvent2.getSender = () => { return { userId: "namersson" } };
      testEvent2.getDate = () => { return new Date(2020, 9, 28, 14, 0, 0); };

      let room = {};
      room.getLiveTimeline = () => {
          let timeline = {};
          timeline.getEvents = () => { return [testEvent, testEvent2]; };
          timeline.getNeighbouringTimeline = (direction) => {
            return null;
          };
          return timeline;
      };

      let foundUsers = {};
      let termObj = makeSearchTermObject("2020-10-28");
      let matches = await findAllMatches(termObj, room, foundUsers);
      expect(matches.length).toBe(1);
      expect(matches[0].result.getSender().userId).toBe("namersson");
      done();
    });

    it("matches users", async (done) => {
      let termObj = makeSearchTermObject("Namesson");
      let isMatch = isMemberMatch({ name: "Name Namesson", userId: "namenamesson" }, termObj);
      expect(isMatch).toBe(true);
      done();
    });
})
